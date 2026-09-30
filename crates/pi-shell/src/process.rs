//! Cross-platform process tree management.

use std::{
	collections::{HashMap, HashSet},
	time::Duration,
};

use anyhow::Result;
use parking_lot::Mutex;
/// Current state of a process reference.
///
/// Defined in `pi-builtins` alongside the process-table snapshots its process
/// builtins read, and re-exported here so this module — and `pi-natives`
/// through it — keeps one status type for both concerns.
pub use pi_builtins::ProcessStatus;

use crate::cancel::CancelToken;

#[cfg(target_os = "linux")]
mod platform {
	use std::{
		collections::HashSet,
		ffi::OsStr,
		fs,
		os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
		ptr,
		sync::Arc,
	};

	use super::ProcessStatus;

	/// Stable Linux process reference backed by a pidfd.
	#[derive(Clone)]
	pub struct Process {
		pid:        i32,
		pidfd:      Arc<OwnedFd>,
		start_time: u64,
	}

	impl Process {
		pub fn from_pid(pid: i32) -> Option<Self> {
			if pid <= 0 {
				return None;
			}
			let pidfd = open_pidfd(pid)?;
			let start_time = read_start_time(pid)?;
			Some(Self { pid, pidfd, start_time })
		}

		pub const fn pid(&self) -> i32 {
			self.pid
		}

		pub fn children(&self) -> Vec<Self> {
			if !self.live_identity() {
				return Vec::new();
			}

			// `/proc/{pid}/task/{tid}/children` is per-task: a child fork()ed from
			// a worker thread appears under that thread's `tid`, not the tgid.
			// Walk every task subdir and union the lists, then re-validate
			// parentage.
			let task_dir = format!("/proc/{}/task", self.pid);
			let Ok(entries) = fs::read_dir(&task_dir) else {
				return Vec::new();
			};

			let mut seen: HashSet<i32> = HashSet::new();
			let mut out = Vec::new();
			let mut children_file_available = false;
			for entry in entries.flatten() {
				let name = entry.file_name();
				let Some(tid_str) = name.to_str() else {
					continue;
				};
				if tid_str.parse::<i32>().is_err() {
					continue;
				}
				let children_path = format!("/proc/{}/task/{}/children", self.pid, tid_str);
				let Ok(content) = fs::read_to_string(&children_path) else {
					continue;
				};
				// The file is readable -> this kernel has CONFIG_PROC_CHILDREN.
				children_file_available = true;
				for part in content.split_whitespace() {
					let Ok(child_pid) = part.parse::<i32>() else {
						continue;
					};
					self.push_validated_child(child_pid, &mut seen, &mut out);
				}
			}

			// Some Kata / microVM guest kernels are built without
			// CONFIG_PROC_CHILDREN, so no `.../children` file exists and the
			// walk above finds nothing — which would silently turn descendant
			// signaling (cancellation cleanup) into a no-op inside such
			// containers. Fall back to scanning `/proc` and grouping
			// by parent pid, the same primitive the macOS path uses. Only taken
			// when no `children` file was readable, so kernels that support it
			// keep the cheap per-task fast path.
			if !children_file_available && let Ok(proc_entries) = fs::read_dir("/proc") {
				for entry in proc_entries.flatten() {
					let name = entry.file_name();
					let Some(pid_str) = name.to_str() else {
						continue;
					};
					let Ok(child_pid) = pid_str.parse::<i32>() else {
						continue;
					};
					self.push_validated_child(child_pid, &mut seen, &mut out);
				}
			}
			out
		}

		/// Validate a candidate child pid — dedup, still running, and currently
		/// parented to `self` — then push it onto `out`. Shared by the
		/// `/proc/<pid>/task/<tid>/children` fast path and the `/proc`-scan
		/// fallback for kernels without `CONFIG_PROC_CHILDREN`.
		fn push_validated_child(&self, child_pid: i32, seen: &mut HashSet<i32>, out: &mut Vec<Self>) {
			if child_pid == self.pid || !seen.insert(child_pid) {
				return;
			}
			let Some(child) = Self::from_pid(child_pid) else {
				return;
			};
			if child.status() == ProcessStatus::Running
				&& current_parent_pid(child.pid) == Some(self.pid)
			{
				out.push(child);
			}
		}

		pub fn parent_pid(&self) -> Option<i32> {
			if self.status() == ProcessStatus::Running {
				current_parent_pid(self.pid)
			} else {
				None
			}
		}

		pub fn args(&self) -> Vec<String> {
			if !self.live_identity() {
				return Vec::new();
			}

			let cmdline_path = format!("/proc/{}/cmdline", self.pid);
			let Ok(content) = fs::read(cmdline_path) else {
				return Vec::new();
			};
			// Re-validate after the read: PID reuse between identity check and
			// read would otherwise leak an impostor's command line to callers.
			if !self.live_identity() {
				return Vec::new();
			}
			split_nul_arguments(&content)
		}

		pub fn kill(&self, signal: i32) -> bool {
			// SAFETY: `self.pidfd` is an owned file descriptor returned by a
			// successful `pidfd_open` call and remains open for the duration of
			// this syscall. A null `siginfo_t` pointer is explicitly accepted
			// by `pidfd_send_signal` and makes the kernel synthesize the same
			// signal metadata as `kill(2)`. Flags are zero, which is the
			// documented default behavior.
			let ret = unsafe {
				libc::syscall(
					libc::SYS_pidfd_send_signal,
					self.pidfd.as_raw_fd(),
					signal,
					ptr::null::<libc::siginfo_t>(),
					0,
				)
			};
			ret == 0
		}

		pub fn group_id(&self) -> Option<i32> {
			if self.status() != ProcessStatus::Running {
				return None;
			}

			// SAFETY: `self.pid` names the process currently referenced by
			// `self.pidfd` unless it exits concurrently. If it exits, `getpgid`
			// reports failure rather than dereferencing caller-owned memory.
			let pgid = unsafe { libc::getpgid(self.pid) };
			if pgid > 0 { Some(pgid) } else { None }
		}

		pub fn status(&self) -> ProcessStatus {
			loop {
				let mut pollfd =
					libc::pollfd { fd: self.pidfd.as_raw_fd(), events: libc::POLLIN, revents: 0 };
				// SAFETY: `pollfd` points to one initialized `pollfd` element, and
				// the pidfd remains open for the duration of the call. Timeout
				// zero makes this a non-blocking readiness probe.
				let ready = unsafe { libc::poll(&raw mut pollfd, 1, 0) };
				if ready < 0 {
					// Retry on EINTR; for any other transient poll error treat the
					// pidfd as still running. The pidfd is still owned and the
					// kernel has not reported the process gone — a spurious
					// `Exited` here makes every downstream signal/kill fall
					// through silently.
					if std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
						continue;
					}
					return ProcessStatus::Running;
				}
				if ready == 0 {
					return ProcessStatus::Running;
				}
				if (pollfd.revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR | libc::POLLNVAL))
					!= 0
				{
					return ProcessStatus::Exited;
				}
				return ProcessStatus::Running;
			}
		}

		/// Walk the descendant tree in post-order (leaves first), de-duplicating
		/// by PID so concurrent reparenting cannot trap us in a cycle.
		pub fn descendants(&self) -> Vec<Self> {
			let mut out = Vec::new();
			let mut visited = HashSet::new();
			visited.insert(self.pid);
			self.descendants_into(&mut out, &mut visited);
			out
		}

		fn descendants_into(&self, out: &mut Vec<Self>, visited: &mut HashSet<i32>) {
			for child in self.children() {
				if visited.insert(child.pid) {
					child.descendants_into(out, visited);
					out.push(child);
				}
			}
		}

		fn live_identity(&self) -> bool {
			self.status() == ProcessStatus::Running
				&& read_start_time(self.pid) == Some(self.start_time)
		}

		/// Start time pinned at open, in Unix epoch seconds (floor): boot time
		/// plus the `/proc/<pid>/stat` start tick count, as `ps -o lstart` does.
		pub fn start_time_unix_secs(&self) -> Option<u64> {
			start_ticks_to_unix_secs(self.start_time)
		}

		/// `/proc/<pid>/stat` start ticks since boot, pinned at open.
		pub const fn start_id(&self) -> u64 {
			self.start_time
		}
	}

	/// Convert a `/proc/<pid>/stat` start tick count to Unix epoch seconds
	/// (floor).
	fn start_ticks_to_unix_secs(start_ticks: u64) -> Option<u64> {
		// SAFETY: `sysconf` takes a scalar name and touches no caller memory.
		let ticks_per_sec = u64::try_from(unsafe { libc::sysconf(libc::_SC_CLK_TCK) })
			.ok()
			.filter(|ticks| *ticks > 0)?;
		Some(read_boot_time()? + start_ticks / ticks_per_sec)
	}

	/// System boot time in Unix epoch seconds (`btime` in `/proc/stat`).
	fn read_boot_time() -> Option<u64> {
		let content = fs::read_to_string("/proc/stat").ok()?;
		content
			.lines()
			.find_map(|line| line.strip_prefix("btime "))
			.and_then(|btime| btime.trim().parse().ok())
	}

	fn split_nul_arguments(content: &[u8]) -> Vec<String> {
		content
			.split(|byte| *byte == 0)
			.filter(|part| !part.is_empty())
			.map(|part| String::from_utf8_lossy(part).into_owned())
			.collect()
	}

	fn current_parent_pid(pid: i32) -> Option<i32> {
		let status_path = format!("/proc/{pid}/status");
		let content = fs::read_to_string(status_path).ok()?;
		content.lines().find_map(|line| {
			line
				.strip_prefix("PPid:")
				.and_then(|ppid| ppid.trim().parse::<i32>().ok())
		})
	}

	/// The `/proc/<pid>/stat` fields the process scans need.
	struct Stat<'a> {
		comm:        &'a str,
		state:       char,
		ppid:        i32,
		pgrp:        i32,
		/// Field 9, the kernel's `PF_*` task flags.
		flags:       u32,
		start_ticks: u64,
	}

	impl Stat<'_> {
		/// `PF_KTHREAD`: a kernel thread, which has no user-space environment
		/// to carry a marker in.
		const fn is_kernel_thread(&self) -> bool {
			self.flags & 0x0020_0000 != 0
		}
	}

	fn parse_stat(content: &str) -> Option<Stat<'_>> {
		// The comm field (between parens) may itself contain spaces and parens,
		// so locate the *last* `)` and split the trailing whitespace-separated
		// fields: state (field 3), ppid, pgrp, … flags (field 9) and field 22,
		// the start time in clock ticks since boot.
		let first_paren = content.find('(')?;
		let last_paren = content.rfind(')')?;
		let comm = content.get(first_paren + 1..last_paren)?;
		let mut fields = content[last_paren + 1..].split_whitespace();
		let state = fields.next()?.chars().next()?;
		let ppid = fields.next()?.parse().ok()?;
		let pgrp = fields.next()?.parse().ok()?;
		let flags = fields.nth(3)?.parse().ok()?;
		let start_ticks = fields.nth(12)?.parse().ok()?;
		Some(Stat { comm, state, ppid, pgrp, flags, start_ticks })
	}

	fn read_start_time(pid: i32) -> Option<u64> {
		let content = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
		parse_stat(&content).map(|stat| stat.start_ticks)
	}

	/// Process group of `pid`, zombies included (their `stat` stays readable
	/// until reaped).
	pub fn process_group_of(pid: i32) -> Option<i32> {
		let content = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
		parse_stat(&content)
			.map(|stat| stat.pgrp)
			.filter(|pgrp| *pgrp > 0)
	}

	pub fn process_identity(pid: i32) -> super::ProcessIdentity {
		match fs::read_to_string(format!("/proc/{pid}/stat")) {
			Ok(content) => match parse_stat(&content) {
				Some(stat) if leader_exited(pid, stat.state) => super::ProcessIdentity::GONE,
				Some(stat) => super::ProcessIdentity::running(
					stat.start_ticks,
					start_ticks_to_unix_secs(stat.start_ticks),
				),
				None => super::unreadable_unless_gone(pid),
			},
			Err(err) if matches!(err.raw_os_error(), Some(libc::EACCES | libc::EPERM)) => {
				super::ProcessIdentity::UNREADABLE
			},
			// ENOENT/ESRCH usually mean gone, but `hidepid` hides live processes
			// the same way: let `kill(pid, 0)` decide.
			Err(_) => super::unreadable_unless_gone(pid),
		}
	}

	/// True when the process whose thread-group leader is in `state` has
	/// exited: the leader is a zombie (or dead) and no other thread is left.
	/// A leader that called `pthread_exit` shows as a zombie while the rest of
	/// its threads keep running.
	fn leader_exited(pid: i32, state: char) -> bool {
		matches!(state, 'Z' | 'X')
			&& !fs::read_to_string(format!("/proc/{pid}/status"))
				.is_ok_and(|status| status_threads(&status).is_some_and(|threads| threads > 1))
	}

	/// The `Threads:` count of `/proc/<pid>/status`: live threads, plus a
	/// zombie leader not yet released.
	fn status_threads(status: &str) -> Option<u32> {
		status
			.lines()
			.find_map(|line| line.strip_prefix("Threads:"))?
			.trim()
			.parse()
			.ok()
	}

	/// Real, effective and saved uid from the `Uid:` line of
	/// `/proc/<pid>/status`.
	pub(super) fn status_uids(status: &str) -> Option<[libc::uid_t; 3]> {
		let mut ids = status
			.lines()
			.find_map(|line| line.strip_prefix("Uid:"))?
			.split_whitespace()
			.map(|id| id.parse().ok());
		Some([ids.next()??, ids.next()??, ids.next()??])
	}

	/// A live process the scan must examine.
	enum Candidate<'a> {
		/// Its `stat` parsed.
		Stat(&'a Stat<'a>),
		/// Not provably gone, but its `stat` could not be read.
		Unreadable,
	}

	/// Calls `visit` for every live process except the caller that may belong
	/// to this user: its real, effective or saved uid is one of ours, or its
	/// uids cannot be read. Kernel threads, which have no environment, are
	/// skipped. Returns false when the process table (`/proc`) cannot be
	/// listed.
	fn for_each_candidate_process(mut visit: impl FnMut(i32, Candidate<'_>)) -> bool {
		let Ok(entries) = fs::read_dir("/proc") else {
			return false;
		};
		let ours = super::own_uids();
		let self_pid = std::process::id();
		for entry in entries.flatten() {
			let Some(pid) = entry
				.file_name()
				.to_str()
				.and_then(|name| name.parse::<u32>().ok())
			else {
				continue;
			};
			if pid == self_pid {
				continue;
			}
			let Ok(pid) = i32::try_from(pid) else {
				continue;
			};
			// Only a readable uid set can rule a process out: a setuid launch
			// keeps our uid as its real (or saved) uid, and one whose `status`
			// cannot be read (`hidepid`) may be ours.
			let status = fs::read_to_string(format!("/proc/{pid}/status")).ok();
			if let Some(ids) = status.as_deref().and_then(status_uids)
				&& !super::uid_candidate(ids, ours)
			{
				continue;
			}
			let stat_content = fs::read_to_string(format!("/proc/{pid}/stat")).ok();
			match stat_content.as_deref().and_then(parse_stat) {
				Some(stat) => {
					let exited = matches!(stat.state, 'Z' | 'X')
						&& !status
							.as_deref()
							.and_then(status_threads)
							.is_some_and(|threads| threads > 1);
					if !exited && !stat.is_kernel_thread() {
						visit(pid, Candidate::Stat(&stat));
					}
				},
				None => {
					if super::unreadable_unless_gone(pid).state == super::IdentityState::Unreadable {
						visit(pid, Candidate::Unreadable);
					}
				},
			}
		}
		true
	}

	/// Live processes (except the caller, any user) whose process group is in
	/// `groups`, or `None` when the process table cannot be listed.
	pub fn list_group_members(groups: &HashSet<i32>) -> Option<super::GroupListing> {
		let entries = fs::read_dir("/proc").ok()?;
		let self_pid = std::process::id();
		// Under `hidepid` a member may be missing from the listing entirely.
		let mut listing =
			super::GroupListing { partial: proc_hides_processes(), ..Default::default() };
		for entry in entries.flatten() {
			let Some(pid) = entry
				.file_name()
				.to_str()
				.and_then(|name| name.parse::<u32>().ok())
				.filter(|pid| *pid != self_pid)
				.and_then(|pid| i32::try_from(pid).ok())
			else {
				continue;
			};
			let stat_content = fs::read_to_string(format!("/proc/{pid}/stat")).ok();
			match stat_content.as_deref().and_then(parse_stat) {
				Some(stat) => {
					if groups.contains(&stat.pgrp) {
						listing.seen.insert(stat.pgrp);
						if !leader_exited(pid, stat.state) {
							listing.members.push((pid, stat.pgrp));
						}
					}
				},
				None => {
					// Live, but its group is unknown: it may be a member.
					if super::unreadable_unless_gone(pid).state == super::IdentityState::Unreadable {
						listing.partial = true;
					}
				},
			}
		}
		Some(listing)
	}

	/// True unless the `/proc` this process lists is known to show every
	/// process: mounted without `hidepid` (or with `hidepid=0`/`off`).
	fn proc_hides_processes() -> bool {
		fs::read_to_string("/proc/self/mountinfo")
			.map_or(true, |mountinfo| mountinfo_hides_processes(&mountinfo))
	}

	/// Whether the last `proc` mount on `/proc` in a `/proc/<pid>/mountinfo`
	/// listing sets `hidepid` to anything but `0`/`off`; true when there is no
	/// such mount.
	pub(super) fn mountinfo_hides_processes(mountinfo: &str) -> bool {
		let mut hides = None;
		for line in mountinfo.lines() {
			// `id parent major:minor root mount-point mount-options [optional…] -
			// fstype source super-options`
			let Some((mount, filesystem)) = line.split_once(" - ") else {
				continue;
			};
			let mut mount = mount.split(' ').skip(4);
			let (Some(mount_point), Some(mount_options)) = (mount.next(), mount.next()) else {
				continue;
			};
			let mut filesystem = filesystem.split(' ');
			let (Some(fstype), Some(super_options)) = (filesystem.next(), filesystem.nth(1)) else {
				continue;
			};
			if fstype != "proc" || mount_point != "/proc" {
				continue;
			}
			// A later mount on the same point covers the earlier ones.
			hides = Some(
				mount_options
					.split(',')
					.chain(super_options.split(','))
					.filter_map(|option| option.strip_prefix("hidepid="))
					.any(|value| !matches!(value, "0" | "off")),
			);
		}
		hides.unwrap_or(true)
	}

	pub fn scan_processes_by_env(
		name: &str,
		tokens: &[&str],
		opaque_since: Option<u64>,
	) -> super::MarkedProcessScan {
		let mut scan = super::MarkedProcessScan {
			supported: true,
			hidden: proc_hides_processes(),
			..Default::default()
		};
		let listed = for_each_candidate_process(|pid, candidate| {
			scan.scanned += 1;
			let Candidate::Stat(stat) = candidate else {
				scan.unreadable += 1;
				scan.push_opaque(super::MarkedProcess::unidentified(pid), opaque_since);
				return;
			};
			let mut entry = super::MarkedProcess {
				pid,
				ppid: stat.ppid,
				pgid: Some(stat.pgrp).filter(|pgrp| *pgrp > 0),
				start_time: start_ticks_to_unix_secs(stat.start_ticks),
				start_id: Some(stat.start_ticks),
				command: stat.comm.to_owned(),
				token: None,
			};
			let Ok(environ) = fs::read(format!("/proc/{pid}/environ")) else {
				// Non-dumpable processes (setuid launches, `PR_SET_DUMPABLE 0`)
				// deny the read; a vanished directory means it simply exited.
				if fs::exists(format!("/proc/{pid}")).unwrap_or(true) {
					scan.unreadable += 1;
					scan.push_opaque(entry, opaque_since);
				}
				return;
			};
			let mut env = environ
				.split(|byte| *byte == 0)
				.filter(|entry| !entry.is_empty());
			let Some(first) = env.next() else {
				// Empty: started with no environment, or a zombie leader whose
				// memory is gone while its other threads run.
				scan.redacted += 1;
				scan.push_opaque(entry, opaque_since);
				return;
			};
			if let Some(token) =
				super::env_marker_token(std::iter::once(first).chain(env), name, tokens)
			{
				entry.token = Some(token.to_owned());
				scan.processes.push(entry);
			}
		});
		if listed {
			scan
		} else {
			super::MarkedProcessScan::default()
		}
	}

	#[cfg(test)]
	mod stat_tests {
		/// A comm with spaces and parens must not shift the fields; a kernel
		/// thread is told apart by its flags.
		#[test]
		fn parse_stat_reads_fields_after_the_last_paren() {
			let line = "42 (a) (b c) S 2 0 0 0 -1 2129984 0 0 0 0 0 0 0 0 20 0 1 0 12345 0 0";
			let stat = super::parse_stat(line).expect("parses");
			assert_eq!(stat.comm, "a) (b c");
			assert_eq!((stat.state, stat.ppid, stat.pgrp), ('S', 2, 0));
			assert_eq!(stat.start_ticks, 12345);
			assert!(stat.is_kernel_thread(), "flags 0x208040 carry PF_KTHREAD");
			let user = line.replace(" 2129984 ", " 4194560 ");
			assert!(!super::parse_stat(&user).expect("parses").is_kernel_thread());
		}
	}

	fn open_pidfd(pid: i32) -> Option<Arc<OwnedFd>> {
		// SAFETY: `pidfd_open` takes the PID by value and does not read
		// caller-owned memory. Flags are zero, which is valid. On success the
		// returned descriptor is newly owned by this process and is immediately
		// wrapped in `OwnedFd` below.
		let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
		if fd < 0 {
			return None;
		}

		// SAFETY: `fd` is non-negative and was just returned by `pidfd_open`, so
		// it is an open descriptor owned by this process. `OwnedFd` takes sole
		// ownership and will close it exactly once.
		Some(Arc::new(unsafe { OwnedFd::from_raw_fd(fd as RawFd) }))
	}

	/// Send `signal` to the process group `pgid`.
	/// Returns true when the signal is delivered successfully.
	pub fn kill_process_group(pgid: i32, signal: i32) -> bool {
		// SAFETY: `kill` takes integer identifiers by value and does not access
		// caller-owned memory. A negative PID is the POSIX process-group form.
		unsafe { libc::kill(-pgid, signal) == 0 }
	}

	/// Find processes whose `/proc/{pid}/exe` symlink resolves to exactly
	/// `target`.
	pub fn find_by_path(target: &str) -> Vec<Process> {
		let mut matches = Vec::new();
		let Ok(entries) = fs::read_dir("/proc") else {
			return matches;
		};
		let target_os = OsStr::new(target);
		for entry in entries.flatten() {
			let name = entry.file_name();
			let Some(name_str) = name.to_str() else {
				continue;
			};
			let Ok(pid) = name_str.parse::<i32>() else {
				continue;
			};
			let exe_path = format!("/proc/{pid}/exe");
			let Ok(resolved) = fs::read_link(&exe_path) else {
				continue;
			};
			if resolved.as_os_str() == target_os
				&& let Some(process) = Process::from_pid(pid)
			{
				matches.push(process);
			}
		}
		matches
	}
}

/// Translate libproc's PID count into a padded allocation and its C byte size.
#[cfg(any(target_os = "macos", test))]
fn macos_pid_buffer_size(reported: i32) -> Option<(usize, i32)> {
	let count = usize::try_from(reported).ok().filter(|count| *count > 0)?;
	let capacity = count.saturating_mul(4).max(2048);
	let bytes = i32::try_from(capacity.checked_mul(size_of::<i32>())?).ok()?;
	Some((capacity, bytes))
}

#[cfg(target_os = "macos")]
mod platform {
	use std::{
		collections::{HashMap, HashSet},
		ptr,
	};

	use super::ProcessStatus;

	#[link(name = "proc", kind = "dylib")]
	unsafe extern "C" {
		fn proc_listallpids(buffer: *mut i32, buffersize: i32) -> i32;
		fn proc_pidpath(pid: i32, buffer: *mut std::ffi::c_void, buffersize: u32) -> i32;
	}

	/// macOS does not expose pidfds; identity is pinned via the kernel-reported
	/// process start time so a recycled PID does not silently impersonate the
	/// original target.
	#[derive(Clone)]
	pub struct Process {
		pid:          i32,
		start_tvsec:  u64,
		start_tvusec: u64,
	}

	impl Process {
		pub fn from_pid(pid: i32) -> Option<Self> {
			if pid <= 0 {
				return None;
			}
			let info = read_bsdinfo(pid)?;
			if i32::try_from(info.pbi_pid).ok()? != pid {
				return None;
			}
			Some(Self { pid, start_tvsec: info.pbi_start_tvsec, start_tvusec: info.pbi_start_tvusec })
		}

		/// Start time pinned at open, in Unix epoch seconds (floor).
		#[allow(clippy::unnecessary_wraps, reason = "matches the fallible Linux/Windows signature")]
		pub const fn start_time_unix_secs(&self) -> Option<u64> {
			Some(self.start_tvsec)
		}

		/// Start microseconds since the epoch, pinned at open.
		pub const fn start_id(&self) -> u64 {
			start_id(self.start_tvsec, self.start_tvusec)
		}

		pub const fn pid(&self) -> i32 {
			self.pid
		}

		pub fn children(&self) -> Vec<Self> {
			if self.live_bsdinfo().is_none() {
				return Vec::new();
			}
			// `proc_listchildpids` (the obvious choice) is broken on recent macOS
			// kernels when queried for the *calling* process — it returns one byte
			// of padding regardless of how many children the process actually
			// has, so a process can never list its own descendants. Confirmed
			// on darwin 25.4 from C, Rust, and Bun callers via
			// `proc_listchildpids(getpid(), …)`, while `ps -P` and `pgrep -P`
			// still see the same children. Walk the whole pid table via
			// `proc_listallpids` and filter on `pbi_ppid` instead; this is the
			// same approach we already use for `find_by_path` and that the
			// Windows implementation uses via Toolhelp snapshots.
			let tree = build_process_tree();
			Self::children_from_tree(self.pid, &tree)
		}

		pub fn parent_pid(&self) -> Option<i32> {
			let info = self.live_bsdinfo()?;
			i32::try_from(info.pbi_ppid).ok().filter(|ppid| *ppid > 0)
		}

		pub fn args(&self) -> Vec<String> {
			if self.live_bsdinfo().is_none() {
				return Vec::new();
			}
			process_args(self.pid)
		}

		pub fn kill(&self, signal: i32) -> bool {
			// Re-validate identity right before signaling. There is no atomic
			// "kill iff start_time matches" primitive on macOS, so a vanishingly
			// small window remains between this check and the syscall — but
			// matching against the recorded `(pid, start_tvsec, start_tvusec)`
			// triple eliminates the PID-reuse race in every practical case.
			if self.live_bsdinfo().is_none() {
				return false;
			}
			// SAFETY: `kill` takes integer identifiers by value and does not
			// access caller-owned memory.
			unsafe { libc::kill(self.pid, signal) == 0 }
		}

		pub fn group_id(&self) -> Option<i32> {
			let info = self.live_bsdinfo()?;
			i32::try_from(info.pbi_pgid).ok().filter(|pgid| *pgid > 0)
		}

		/// Walk the descendant tree in post-order (leaves first), de-duplicating
		/// by PID so concurrent reparenting cannot trap us in a cycle.
		pub fn descendants(&self) -> Vec<Self> {
			// One process-table snapshot per walk — building it inside the
			// recursion would re-scan every pid for every visited node,
			// producing an `O(N · D)` kernel call pattern. Mirrors the Windows
			// implementation.
			let tree = build_process_tree();
			let mut out = Vec::new();
			let mut visited = HashSet::new();
			visited.insert(self.pid);
			Self::collect_descendants_from_tree(self.pid, &tree, &mut visited, &mut out);
			out
		}

		fn children_from_tree(parent: i32, tree: &HashMap<i32, Vec<i32>>) -> Vec<Self> {
			let Some(child_pids) = tree.get(&parent) else {
				return Vec::new();
			};
			child_pids
				.iter()
				.copied()
				.filter_map(Self::from_pid)
				.collect()
		}

		fn collect_descendants_from_tree(
			parent: i32,
			tree: &HashMap<i32, Vec<i32>>,
			visited: &mut HashSet<i32>,
			out: &mut Vec<Self>,
		) {
			let Some(child_pids) = tree.get(&parent) else {
				return;
			};
			for &child_pid in child_pids {
				if !visited.insert(child_pid) {
					continue;
				}
				let Some(child) = Self::from_pid(child_pid) else {
					continue;
				};
				// Post-order: grandchildren first, so leaf processes get signalled
				// before their parents during tree termination.
				Self::collect_descendants_from_tree(child_pid, tree, visited, out);
				out.push(child);
			}
		}

		pub fn status(&self) -> ProcessStatus {
			if self.live_bsdinfo().is_some() {
				ProcessStatus::Running
			} else {
				ProcessStatus::Exited
			}
		}

		/// Returns the current `proc_bsdinfo` only if it still describes the same
		/// process this reference was opened on — i.e. the start time has not
		/// changed.
		fn live_bsdinfo(&self) -> Option<libc::proc_bsdinfo> {
			let info = read_bsdinfo(self.pid)?;
			if info.pbi_start_tvsec == self.start_tvsec && info.pbi_start_tvusec == self.start_tvusec {
				Some(info)
			} else {
				None
			}
		}
	}

	/// Send `signal` to the process group `pgid`.
	/// Returns true when the signal is delivered successfully.
	pub fn kill_process_group(pgid: i32, signal: i32) -> bool {
		// SAFETY: `kill` takes integer identifiers by value and does not access
		// caller-owned memory. A negative PID is the POSIX process-group form.
		unsafe { libc::kill(-pgid, signal) == 0 }
	}

	const KERN_PROCARGS2: libc::c_int = 49;

	const PROC_PIDPATHINFO_MAXSIZE: usize = 4096;

	/// Snapshot every pid currently visible to `proc_listallpids`, or `None`
	/// when the table cannot be listed. macOS silently truncates the second
	/// call to the supplied buffer size even when the sizing query reports
	/// more PIDs available, so the buffer is padded well beyond the reported
	/// count.
	fn snapshot_all_pids() -> Option<Vec<i32>> {
		// SAFETY: Passing a null buffer with size 0 is the documented libproc
		// query form for obtaining the PID count; libproc
		// does not dereference the null pointer in this mode.
		let reported = unsafe { proc_listallpids(ptr::null_mut(), 0) };
		let (cap, byte_capacity) = super::macos_pid_buffer_size(reported)?;
		let mut buffer = vec![0i32; cap];
		// SAFETY: `buffer` is valid for `buffer.len() * size_of::<i32>()` bytes
		// and is properly aligned for `i32`; libproc writes at most the
		// supplied size.
		let actual = unsafe { proc_listallpids(buffer.as_mut_ptr(), byte_capacity) };
		if actual <= 0 {
			return None;
		}
		let pid_count = (actual as usize).min(buffer.len());
		buffer.truncate(pid_count);
		Some(buffer)
	}

	/// Build a `ppid -> [pids]` map from a one-shot scan of `proc_listallpids`.
	///
	/// Used as the foundation of `Process::children` and `Process::descendants`
	/// on macOS where `proc_listchildpids` returns no children for self-queries.
	pub(super) fn build_process_tree() -> HashMap<i32, Vec<i32>> {
		let pids = snapshot_all_pids().unwrap_or_default();
		let mut tree: HashMap<i32, Vec<i32>> = HashMap::with_capacity(pids.len() / 2);
		for pid in pids {
			if pid <= 0 {
				continue;
			}
			let Some(info) = read_bsdinfo(pid) else {
				continue;
			};
			let Ok(ppid) = i32::try_from(info.pbi_ppid) else {
				continue;
			};
			if ppid <= 0 {
				continue;
			}
			tree.entry(ppid).or_default().push(pid);
		}
		tree
	}

	/// Find processes whose libproc-reported executable path equals `target`.
	pub fn find_by_path(target: &str) -> Vec<Process> {
		let pids = snapshot_all_pids().unwrap_or_default();
		let mut path_buf = vec![0u8; PROC_PIDPATHINFO_MAXSIZE];
		let mut matches = Vec::new();
		for pid in pids {
			if pid <= 0 {
				continue;
			}
			// SAFETY: `path_buf` is valid for `path_buf.len()` bytes; libproc
			// writes a NUL-terminated path no longer than the supplied capacity
			// and returns the number of bytes written.
			let len = unsafe {
				proc_pidpath(
					pid,
					path_buf.as_mut_ptr().cast::<std::ffi::c_void>(),
					path_buf.len() as u32,
				)
			};
			if len <= 0 {
				continue;
			}
			let path_bytes = &path_buf[..len as usize];
			let path_bytes = match path_bytes.iter().position(|byte| *byte == 0) {
				Some(end) => &path_bytes[..end],
				None => path_bytes,
			};
			let Ok(path) = std::str::from_utf8(path_bytes) else {
				continue;
			};
			if path == target
				&& let Some(process) = Process::from_pid(pid)
			{
				matches.push(process);
			}
		}
		matches
	}

	/// `proc_bsdinfo` of a live (non-zombie) `pid`.
	fn read_bsdinfo(pid: i32) -> Option<libc::proc_bsdinfo> {
		read_bsdinfo_with(pid, 0).ok()
	}

	/// `PROC_PIDTBSDINFO` for `pid`; errors carry the errno. `arg` 1 also
	/// finds zombies (xnu's `findzomb`), which `arg` 0 reports as missing.
	fn read_bsdinfo_with(pid: i32, arg: u64) -> Result<libc::proc_bsdinfo, i32> {
		// SAFETY: `proc_bsdinfo` is a plain C data struct. Zero initialization is
		// valid because every field is an integer or fixed-size integer array,
		// and libproc fully overwrites the fields it reports on a successful
		// call.
		let mut info = unsafe { std::mem::zeroed::<libc::proc_bsdinfo>() };
		// SAFETY: `info` is a writable `proc_bsdinfo` buffer whose exact byte
		// size is supplied to libproc. The PID, flavor, and arg are scalar
		// values passed by value; libproc writes at most the supplied buffer
		// size.
		let actual = unsafe {
			libc::proc_pidinfo(
				pid,
				libc::PROC_PIDTBSDINFO,
				arg,
				(&raw mut info).cast::<std::ffi::c_void>(),
				size_of::<libc::proc_bsdinfo>() as i32,
			)
		};
		if actual < size_of::<libc::proc_bsdinfo>() as i32 {
			return Err(if actual <= 0 { last_errno() } else { libc::EIO });
		}
		Ok(info)
	}

	/// Start microseconds since the epoch: the macOS start id.
	const fn start_id(tvsec: u64, tvusec: u64) -> u64 {
		tvsec.saturating_mul(1_000_000).saturating_add(tvusec)
	}

	/// Process group of `pid`, zombies included.
	pub fn process_group_of(pid: i32) -> Option<i32> {
		let info = read_bsdinfo_with(pid, 1).ok()?;
		i32::try_from(info.pbi_pgid).ok().filter(|pgid| *pgid > 0)
	}

	pub fn process_identity(pid: i32) -> super::ProcessIdentity {
		match read_bsdinfo_with(pid, 0) {
			Ok(info) if info.pbi_status == libc::SZOMB => super::ProcessIdentity::GONE,
			Ok(info) if i32::try_from(info.pbi_pid).ok() == Some(pid) => {
				super::ProcessIdentity::running(
					start_id(info.pbi_start_tvsec, info.pbi_start_tvusec),
					Some(info.pbi_start_tvsec),
				)
			},
			Ok(_) => super::ProcessIdentity::UNREADABLE,
			Err(libc::ESRCH) => {
				// A zombie is invisible to the plain lookup; the zombie-aware one
				// tells it apart from a live process we may not inspect.
				if read_bsdinfo_with(pid, 1).is_ok_and(|info| info.pbi_status == libc::SZOMB) {
					super::ProcessIdentity::GONE
				} else {
					super::unreadable_unless_gone(pid)
				}
			},
			Err(_) => super::unreadable_unless_gone(pid),
		}
	}

	/// `PROC_PIDT_SHORTBSDINFO` for `pid`, zombies included; errors carry the
	/// errno. Unlike `PROC_PIDTBSDINFO`, the kernel answers it for other users'
	/// processes too.
	fn read_shortinfo(pid: i32) -> Result<libc::proc_bsdshortinfo, i32> {
		// SAFETY: `proc_bsdshortinfo` is a plain C data struct of integers and
		// integer arrays, so zero initialization is valid.
		let mut info = unsafe { std::mem::zeroed::<libc::proc_bsdshortinfo>() };
		// SAFETY: `info` is a writable `proc_bsdshortinfo` buffer whose exact
		// byte size is supplied; libproc writes at most that many bytes.
		let actual = unsafe {
			libc::proc_pidinfo(
				pid,
				libc::PROC_PIDT_SHORTBSDINFO,
				0,
				(&raw mut info).cast::<std::ffi::c_void>(),
				size_of::<libc::proc_bsdshortinfo>() as i32,
			)
		};
		if actual < size_of::<libc::proc_bsdshortinfo>() as i32 {
			return Err(if actual <= 0 { last_errno() } else { libc::EIO });
		}
		Ok(info)
	}

	/// A live process the scan must examine.
	enum Candidate<'a> {
		/// Its full `proc_bsdinfo` is readable.
		Info(&'a libc::proc_bsdinfo),
		/// Not provably gone, but its start time cannot be read; what the short
		/// info showed, if anything.
		Unreadable { ppid: i32, pgid: Option<i32>, command: String },
	}

	/// Calls `visit` for every live process except the caller that may belong
	/// to this user: its real, effective or saved uid is one of ours, or its
	/// uids cannot be read. Returns false when the process table cannot be
	/// listed.
	fn for_each_candidate_process(mut visit: impl FnMut(i32, Candidate<'_>)) -> bool {
		let Some(pids) = snapshot_all_pids() else {
			return false;
		};
		let ours = super::own_uids();
		// SAFETY: `getpid` takes no arguments and cannot fail.
		let self_pid = unsafe { libc::getpid() };
		for pid in pids {
			if pid <= 0 || pid == self_pid {
				continue;
			}
			// The full info fails for zombies, exited processes and — with EPERM
			// — processes we may not inspect; the short info still shows the
			// latter's uids.
			if let Ok(info) = read_bsdinfo_with(pid, 0) {
				if info.pbi_status != libc::SZOMB
					&& super::uid_candidate([info.pbi_ruid, info.pbi_uid, info.pbi_svuid], ours)
				{
					visit(pid, Candidate::Info(&info));
				}
				continue;
			}
			match read_shortinfo(pid) {
				Ok(info) => {
					if info.pbsi_status != libc::SZOMB
						&& super::uid_candidate([info.pbsi_ruid, info.pbsi_uid, info.pbsi_svuid], ours)
					{
						visit(pid, Candidate::Unreadable {
							ppid:    i32::try_from(info.pbsi_ppid).unwrap_or(0),
							pgid:    i32::try_from(info.pbsi_pgid).ok().filter(|pgid| *pgid > 0),
							command: c_chars(&info.pbsi_comm),
						});
					}
				},
				// ESRCH: exiting, or still being created (its parent, which it
				// copies, is examined).
				Err(libc::ESRCH) => {},
				Err(_) => {
					if process_identity(pid).state == super::IdentityState::Unreadable {
						visit(pid, Candidate::Unreadable {
							ppid:    0,
							pgid:    None,
							command: String::new(),
						});
					}
				},
			}
		}
		true
	}

	/// Live processes (except the caller, any user) whose process group is in
	/// `groups`, or `None` when the process table cannot be listed.
	pub fn list_group_members(groups: &HashSet<i32>) -> Option<super::GroupListing> {
		let pids = snapshot_all_pids()?;
		// SAFETY: `getpid` takes no arguments and cannot fail.
		let self_pid = unsafe { libc::getpid() };
		let mut listing = super::GroupListing::default();
		for pid in pids {
			if pid <= 0 || pid == self_pid {
				continue;
			}
			match read_shortinfo(pid) {
				Ok(info) => {
					if let Ok(pgid) = i32::try_from(info.pbsi_pgid)
						&& groups.contains(&pgid)
					{
						listing.seen.insert(pgid);
						if info.pbsi_status != libc::SZOMB {
							listing.members.push((pid, pgid));
						}
					}
				},
				// ESRCH: exiting, or still being created — not a member yet.
				Err(libc::ESRCH) => {},
				Err(_) => {
					// Live, but its group is unknown: it may be a member.
					if process_identity(pid).state == super::IdentityState::Unreadable {
						listing.partial = true;
					}
				},
			}
		}
		Some(listing)
	}

	fn process_args(pid: i32) -> Vec<String> {
		let mut buffer = Vec::new();
		let Ok(len) = read_procargs(pid, &mut buffer) else {
			return Vec::new();
		};
		split_procargs(&buffer[..len]).map_or_else(Vec::new, |(args, _)| {
			args
				.into_iter()
				.map(|arg| String::from_utf8_lossy(arg).into_owned())
				.collect()
		})
	}

	/// Read the raw `KERN_PROCARGS2` block of `pid` into the front of `buffer`
	/// (grown as needed, never shrunk, so a scan reuses one allocation) and
	/// return its length. Errors carry the `sysctl` errno.
	fn read_procargs(pid: i32, buffer: &mut Vec<u8>) -> Result<usize, i32> {
		let mut mib = [libc::CTL_KERN, KERN_PROCARGS2, pid];
		let mut size = 0usize;
		// SAFETY: `mib` points to three initialized integers and the old-value
		// buffer is null with a zero-length query, which is the documented
		// `sysctl` sizing pattern. `size` is a valid out-parameter for the
		// required byte count.
		let sizing_ok = unsafe {
			libc::sysctl(
				mib.as_mut_ptr(),
				mib.len() as u32,
				ptr::null_mut(),
				&raw mut size,
				ptr::null_mut(),
				0,
			)
		} == 0;
		if !sizing_ok {
			return Err(last_errno());
		}
		if size <= size_of::<libc::c_int>() {
			return Err(libc::EINVAL);
		}

		if buffer.len() < size {
			buffer.resize(size, 0);
		}
		// SAFETY: `mib` still points to three initialized integers. `buffer` is
		// writable for `size` bytes, and `size` is provided as the in/out byte
		// count.
		let read_ok = unsafe {
			libc::sysctl(
				mib.as_mut_ptr(),
				mib.len() as u32,
				buffer.as_mut_ptr().cast::<std::ffi::c_void>(),
				&raw mut size,
				ptr::null_mut(),
				0,
			)
		} == 0;
		if !read_ok {
			return Err(last_errno());
		}
		Ok(size)
	}

	fn last_errno() -> i32 {
		std::io::Error::last_os_error()
			.raw_os_error()
			.unwrap_or(libc::EIO)
	}

	/// Split a `KERN_PROCARGS2` block into its argv entries and the trailing
	/// environment region (NUL-separated `KEY=value` strings), or `None` when
	/// the block does not have that layout.
	pub(super) fn split_procargs(buffer: &[u8]) -> Option<(Vec<&[u8]>, &[u8])> {
		// KERN_PROCARGS2 layout: `argc: i32 | exec_path NUL | NUL padding |
		// argv[0..argc] | env[..]`. The padding ends where the offset from the
		// exec path's start is a multiple of the pointer size. argv entries may
		// be empty, so the argv start is computed rather than found by skipping
		// NULs, and exactly argc entries are consumed: stopping early would let
		// argv entries pass for the environment, and running on would hide
		// environment entries.
		let argc_size = size_of::<libc::c_int>();
		let argc_bytes: [u8; 4] = buffer.get(..argc_size)?.try_into().ok()?;
		let argc = usize::try_from(libc::c_int::from_ne_bytes(argc_bytes)).ok()?;
		let strings = &buffer[argc_size..];
		let path_len = strings.iter().position(|byte| *byte == 0)?;
		let argv_start = (path_len + 1).next_multiple_of(size_of::<usize>());
		if strings
			.get(path_len..argv_start)?
			.iter()
			.any(|byte| *byte != 0)
		{
			return None;
		}
		let mut rest = &strings[argv_start..];
		let mut args = Vec::with_capacity(argc);
		for _ in 0..argc {
			let end = rest.iter().position(|byte| *byte == 0)?;
			args.push(&rest[..end]);
			rest = &rest[end + 1..];
		}
		Some((args, rest))
	}

	/// The bytes of a NUL-terminated C char array, lossily decoded.
	fn c_chars(chars: &[libc::c_char]) -> String {
		let bytes: Vec<u8> = chars
			.iter()
			.map(|&c| c as u8)
			.take_while(|&byte| byte != 0)
			.collect();
		String::from_utf8_lossy(&bytes).into_owned()
	}

	/// `pbi_name` (up to 32 bytes) when set, else the 16-byte `pbi_comm`.
	fn bsdinfo_command(info: &libc::proc_bsdinfo) -> String {
		let name = c_chars(&info.pbi_name);
		if name.is_empty() {
			c_chars(&info.pbi_comm)
		} else {
			name
		}
	}

	pub fn scan_processes_by_env(
		name: &str,
		tokens: &[&str],
		opaque_since: Option<u64>,
	) -> super::MarkedProcessScan {
		let mut scan = super::MarkedProcessScan { supported: true, ..Default::default() };
		let mut buffer = Vec::new();
		let listed = for_each_candidate_process(|pid, candidate| {
			scan.scanned += 1;
			let info = match candidate {
				Candidate::Info(info) => info,
				Candidate::Unreadable { ppid, pgid, command } => {
					scan.unreadable += 1;
					let entry = super::MarkedProcess {
						ppid,
						pgid,
						command,
						..super::MarkedProcess::unidentified(pid)
					};
					scan.push_opaque(entry, opaque_since);
					return;
				},
			};
			let mut entry = super::MarkedProcess {
				pid,
				ppid: i32::try_from(info.pbi_ppid).unwrap_or(0),
				pgid: i32::try_from(info.pbi_pgid).ok().filter(|pgid| *pgid > 0),
				start_time: Some(info.pbi_start_tvsec),
				start_id: Some(start_id(info.pbi_start_tvsec, info.pbi_start_tvusec)),
				command: bsdinfo_command(info),
				token: None,
			};
			let Ok(len) = read_procargs(pid, &mut buffer) else {
				let still_live = read_bsdinfo(pid).is_some_and(|now| {
					now.pbi_start_tvsec == info.pbi_start_tvsec
						&& now.pbi_start_tvusec == info.pbi_start_tvusec
				});
				if still_live {
					scan.unreadable += 1;
					scan.push_opaque(entry, opaque_since);
				}
				return;
			};
			let Some((_, env_region)) = split_procargs(&buffer[..len]) else {
				scan.unreadable += 1;
				scan.push_opaque(entry, opaque_since);
				return;
			};
			// The kernel withholds the environment of Apple platform binaries
			// (`/bin/sh`, `zsh`, `sleep`, …) from non-root callers: the block
			// ends after argv, indistinguishable from an empty environment.
			let mut env = env_region
				.split(|byte| *byte == 0)
				.filter(|entry| !entry.is_empty());
			let Some(first) = env.next() else {
				scan.redacted += 1;
				scan.push_opaque(entry, opaque_since);
				return;
			};
			if let Some(token) =
				super::env_marker_token(std::iter::once(first).chain(env), name, tokens)
			{
				entry.token = Some(token.to_owned());
				scan.processes.push(entry);
			}
		});
		if listed {
			scan
		} else {
			super::MarkedProcessScan::default()
		}
	}
}
#[cfg(target_os = "windows")]
mod platform {
	use std::{
		collections::{HashMap, HashSet},
		ffi::c_void,
		mem,
		sync::Arc,
	};

	use smallvec::SmallVec;

	use super::ProcessStatus;

	#[repr(C)]
	#[allow(non_snake_case, reason = "Windows PROCESSENTRY32W field names must match Win32 ABI")]
	struct PROCESSENTRY32W {
		dwSize:              u32,
		cntUsage:            u32,
		th32ProcessID:       u32,
		th32DefaultHeapID:   usize,
		th32ModuleID:        u32,
		cntThreads:          u32,
		th32ParentProcessID: u32,
		pcPriClassBase:      i32,
		dwFlags:             u32,
		szExeFile:           [u16; 260],
	}

	#[repr(C)]
	struct ProcessBasicInformation {
		exit_status: i32,
		peb_base_address: usize,
		affinity_mask: usize,
		base_priority: i32,
		unique_process_id: usize,
		inherited_from_unique_process_id: usize,
	}

	#[repr(C)]
	#[derive(Clone, Copy)]
	struct UnicodeString {
		length:         u16,
		maximum_length: u16,
		buffer:         usize,
	}

	#[repr(C)]
	#[derive(Clone, Copy)]
	struct PebPartial {
		reserved1:          [u8; 2],
		being_debugged:     u8,
		reserved2:          [u8; 1],
		reserved3:          [usize; 2],
		loader:             usize,
		process_parameters: usize,
	}

	#[repr(C)]
	#[derive(Clone, Copy)]
	struct UserProcessParametersPartial {
		reserved1:       [u8; 16],
		reserved2:       [usize; 10],
		image_path_name: UnicodeString,
		command_line:    UnicodeString,
	}

	#[repr(C)]
	#[derive(Clone, Copy, Default)]
	struct Filetime {
		dw_low_date_time:  u32,
		dw_high_date_time: u32,
	}

	type Handle = *mut c_void;
	type NtStatus = i32;
	const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;
	const PROCESS_QUERY_INFORMATION: u32 = 0x0400;
	const PROCESS_VM_READ: u32 = 0x0010;
	const PROCESS_BASIC_INFORMATION_CLASS: u32 = 0;
	const STATUS_SUCCESS: NtStatus = 0;
	const TH32CS_SNAPPROCESS: u32 = 0x00000002;
	const PROCESS_TERMINATE: u32 = 0x0001;
	const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
	const SYNCHRONIZE: u32 = 0x00100000;
	const PROCESS_REFERENCE_ACCESS: u32 =
		PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE;
	const WAIT_OBJECT_0: u32 = 0;
	const ERROR_INVALID_PARAMETER: u32 = 87;

	#[link(name = "kernel32")]
	unsafe extern "system" {
		fn CreateToolhelp32Snapshot(dwFlags: u32, th32ProcessID: u32) -> Handle;
		fn Process32FirstW(hSnapshot: Handle, lppe: *mut PROCESSENTRY32W) -> i32;
		fn Process32NextW(hSnapshot: Handle, lppe: *mut PROCESSENTRY32W) -> i32;
		fn CloseHandle(hObject: Handle) -> i32;
		fn OpenProcess(dwDesiredAccess: u32, bInheritHandle: i32, dwProcessId: u32) -> Handle;
		fn TerminateProcess(hProcess: Handle, uExitCode: u32) -> i32;
		fn QueryFullProcessImageNameW(
			hProcess: Handle,
			dwFlags: u32,
			lpExeName: *mut u16,
			lpdwSize: *mut u32,
		) -> i32;
		fn WaitForSingleObject(hHandle: Handle, dwMilliseconds: u32) -> u32;
		fn GetProcessTimes(
			hProcess: Handle,
			lpCreationTime: *mut Filetime,
			lpExitTime: *mut Filetime,
			lpKernelTime: *mut Filetime,
			lpUserTime: *mut Filetime,
		) -> i32;
		fn ReadProcessMemory(
			hProcess: Handle,
			lpBaseAddress: *const c_void,
			lpBuffer: *mut c_void,
			nSize: usize,
			lpNumberOfBytesRead: *mut usize,
		) -> i32;
		fn LocalFree(hMem: Handle) -> Handle;
		fn GetLastError() -> u32;
	}

	#[link(name = "shell32")]
	unsafe extern "system" {
		fn CommandLineToArgvW(lpCmdLine: *const u16, pNumArgs: *mut i32) -> *mut *mut u16;
	}

	#[link(name = "ntdll")]
	unsafe extern "system" {
		fn NtQueryInformationProcess(
			ProcessHandle: Handle,
			ProcessInformationClass: u32,
			ProcessInformation: *mut c_void,
			ProcessInformationLength: u32,
			ReturnLength: *mut u32,
		) -> NtStatus;
	}

	struct OwnedHandle {
		raw: isize,
	}

	impl OwnedHandle {
		fn from_raw(raw: Handle) -> Option<Self> {
			if raw.is_null() || raw == INVALID_HANDLE_VALUE {
				None
			} else {
				Some(Self { raw: raw as isize })
			}
		}

		const fn as_raw(&self) -> Handle {
			self.raw as Handle
		}
	}

	impl Drop for OwnedHandle {
		fn drop(&mut self) {
			// SAFETY: `self.raw` was returned by a successful Win32
			// handle-producing function and stored only in this `OwnedHandle`.
			// `Drop` runs once, so this closes the owned handle exactly once
			// and no code uses it afterward.
			let _ = unsafe { CloseHandle(self.as_raw()) };
		}
	}

	#[derive(Clone)]
	/// Stable Windows process reference backed by an owned process handle plus
	/// the kernel-reported creation time, which pins identity even if the PID is
	/// recycled while we hold the handle.
	pub struct Process {
		pid:           i32,
		handle:        Arc<OwnedHandle>,
		creation_time: u64,
	}

	impl Process {
		pub fn from_pid(pid: i32) -> Option<Self> {
			if pid <= 0 {
				return None;
			}
			let pid_u32 = u32::try_from(pid).ok()?;
			let handle = open_process(pid_u32, PROCESS_REFERENCE_ACCESS)?;
			let creation_time = process_creation_time(handle.as_raw())?;
			Some(Self { pid, handle, creation_time })
		}

		/// Start time pinned at open, in Unix epoch seconds (floor). The
		/// creation `FILETIME` counts 100ns intervals since 1601-01-01 UTC.
		pub const fn start_time_unix_secs(&self) -> Option<u64> {
			filetime_to_unix_secs(self.creation_time)
		}

		/// Raw creation `FILETIME`, pinned at open.
		pub const fn start_id(&self) -> u64 {
			self.creation_time
		}
	}

	/// A creation `FILETIME` (100ns intervals since 1601-01-01 UTC) as Unix
	/// epoch seconds (floor).
	const fn filetime_to_unix_secs(filetime: u64) -> Option<u64> {
		const FILETIME_TICKS_PER_SEC: u64 = 10_000_000;
		const UNIX_EPOCH_OFFSET_SECS: u64 = 11_644_473_600;
		(filetime / FILETIME_TICKS_PER_SEC).checked_sub(UNIX_EPOCH_OFFSET_SECS)
	}

	pub fn process_identity(pid: i32) -> super::ProcessIdentity {
		let Ok(pid_u32) = u32::try_from(pid) else {
			return super::ProcessIdentity::GONE;
		};
		let Some(handle) = open_process(pid_u32, PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE)
		else {
			// SAFETY: reads this thread's last-error value; no arguments.
			let error = unsafe { GetLastError() };
			// `OpenProcess` rejects a pid naming no process object with
			// ERROR_INVALID_PARAMETER; anything else (access denied, …) leaves
			// a live process we cannot inspect.
			return if error == ERROR_INVALID_PARAMETER {
				super::ProcessIdentity::GONE
			} else {
				super::ProcessIdentity::UNREADABLE
			};
		};
		// SAFETY: `handle` was opened with `SYNCHRONIZE`; zero timeout probes.
		if unsafe { WaitForSingleObject(handle.as_raw(), 0) } == WAIT_OBJECT_0 {
			// Exited; the object lingers only because a handle is still open.
			return super::ProcessIdentity::GONE;
		}
		match process_creation_time(handle.as_raw()) {
			Some(created) => super::ProcessIdentity::running(created, filetime_to_unix_secs(created)),
			None => super::ProcessIdentity::UNREADABLE,
		}
	}

	/// Windows has no process groups: every group is empty.
	#[allow(clippy::unnecessary_wraps, reason = "matches the fallible Unix signature")]
	pub fn list_group_members(_groups: &HashSet<i32>) -> Option<super::GroupListing> {
		Some(super::GroupListing::default())
	}

	impl Process {
		pub const fn pid(&self) -> i32 {
			self.pid
		}

		pub fn parent_pid(&self) -> Option<i32> {
			process_basic_information(self.handle.as_raw())
				.and_then(|info| i32::try_from(info.inherited_from_unique_process_id).ok())
				.filter(|pid| *pid > 0)
		}

		pub fn args(&self) -> Vec<String> {
			process_command_line(self)
				.as_deref()
				.map(split_windows_command_line)
				.unwrap_or_default()
		}

		pub fn children(&self) -> Vec<Self> {
			let tree = build_process_tree();
			Self::children_from_tree(self.pid, &tree)
		}

		/// Walk the entire descendant tree using a single Toolhelp snapshot.
		///
		/// `children()` recursing per-node would re-snapshot the whole process
		/// table for every visited descendant, making tree termination
		/// `O(N · D)` snapshots. One snapshot per termination wave is enough.
		pub fn descendants(&self) -> Vec<Self> {
			let tree = build_process_tree();
			let Ok(root) = u32::try_from(self.pid) else {
				return Vec::new();
			};
			let mut visited: HashSet<u32> = HashSet::new();
			visited.insert(root);
			let mut out = Vec::new();
			Self::collect_descendants_from_tree(root, &tree, &mut visited, &mut out);
			out
		}

		fn children_from_tree(pid: i32, tree: &HashMap<u32, SmallVec<[u32; 4]>>) -> Vec<Self> {
			let Ok(pid_u32) = u32::try_from(pid) else {
				return Vec::new();
			};
			tree
				.get(&pid_u32)
				.into_iter()
				.flatten()
				.filter_map(|&child_pid| {
					let child = Self::from_pid(i32::try_from(child_pid).ok()?)?;
					(child.status() == ProcessStatus::Running).then_some(child)
				})
				.collect()
		}

		fn collect_descendants_from_tree(
			parent: u32,
			tree: &HashMap<u32, SmallVec<[u32; 4]>>,
			visited: &mut HashSet<u32>,
			out: &mut Vec<Self>,
		) {
			let Some(children) = tree.get(&parent) else {
				return;
			};
			for &child_pid in children {
				if !visited.insert(child_pid) {
					continue;
				}
				let Ok(child_pid_i) = i32::try_from(child_pid) else {
					continue;
				};
				let Some(child) = Self::from_pid(child_pid_i) else {
					continue;
				};
				if child.status() != ProcessStatus::Running {
					continue;
				}
				// Post-order: collect grandchildren first so leaves are signalled
				// before their parents during tree termination.
				Self::collect_descendants_from_tree(child_pid, tree, visited, out);
				out.push(child);
			}
		}

		pub fn kill(&self, _signal: i32) -> bool {
			// The handle pins the original kernel process object even after the
			// PID is recycled, so `TerminateProcess` cannot accidentally hit a
			// different process. SAFETY: `self.handle` is an owned process
			// handle opened with `PROCESS_TERMINATE` access and remains valid
			// for the duration of this call. The exit code is passed by value.
			unsafe { TerminateProcess(self.handle.as_raw(), 1) != 0 }
		}

		pub const fn group_id() -> Option<i32> {
			None
		}

		pub fn status(&self) -> ProcessStatus {
			// `WaitForSingleObject` on a process handle opened with `SYNCHRONIZE`
			// is the definitive liveness probe: the handle becomes signalled
			// iff the process has exited. This avoids the `STILL_ACTIVE == 259`
			// pitfall in `GetExitCodeProcess`, where a process that
			// legitimately exits with code 259 is indistinguishable from a
			// still-running one.
			//
			// SAFETY: `self.handle` is an owned process handle opened with
			// `SYNCHRONIZE` access. A zero timeout makes this a non-blocking
			// probe.
			let result = unsafe { WaitForSingleObject(self.handle.as_raw(), 0) };
			if result == WAIT_OBJECT_0 {
				ProcessStatus::Exited
			} else {
				ProcessStatus::Running
			}
		}
	}

	fn process_basic_information(handle: Handle) -> Option<ProcessBasicInformation> {
		let mut info = ProcessBasicInformation {
			exit_status: 0,
			peb_base_address: 0,
			affinity_mask: 0,
			base_priority: 0,
			unique_process_id: 0,
			inherited_from_unique_process_id: 0,
		};
		let mut returned = 0u32;
		// SAFETY: `handle` is a valid process handle. `info` is writable for
		// exactly `size_of::<ProcessBasicInformation>()` bytes, and `returned`
		// is a valid optional out-parameter for the byte count.
		let status = unsafe {
			NtQueryInformationProcess(
				handle,
				PROCESS_BASIC_INFORMATION_CLASS,
				(&raw mut info).cast::<c_void>(),
				mem::size_of::<ProcessBasicInformation>() as u32,
				&raw mut returned,
			)
		};
		(status == STATUS_SUCCESS).then_some(info)
	}

	fn process_command_line(process: &Process) -> Option<String> {
		let pid_u32 = u32::try_from(process.pid).ok()?;
		let read_handle = open_process(pid_u32, PROCESS_QUERY_INFORMATION | PROCESS_VM_READ)?;
		// PID-reuse defense: `OpenProcess` resolves a PID to *whichever* process
		// owns it right now, which need not be the one our original handle
		// pinned. Compare the freshly opened handle's creation time against the
		// recorded value to reject reads from an unrelated process that happens
		// to share the PID.
		if process_creation_time(read_handle.as_raw())? != process.creation_time {
			return None;
		}
		let info = process_basic_information(read_handle.as_raw())?;
		let peb: PebPartial = read_remote(read_handle.as_raw(), info.peb_base_address)?;
		if peb.process_parameters == 0 {
			return None;
		}
		let params: UserProcessParametersPartial =
			read_remote(read_handle.as_raw(), peb.process_parameters)?;
		read_remote_unicode_string(read_handle.as_raw(), params.command_line)
	}

	fn process_creation_time(handle: Handle) -> Option<u64> {
		let mut creation = Filetime::default();
		let mut exit = Filetime::default();
		let mut kernel = Filetime::default();
		let mut user = Filetime::default();
		// SAFETY: `handle` is a valid process handle opened with at least
		// `PROCESS_QUERY_LIMITED_INFORMATION`. All four out-parameters point to
		// initialized, writable `Filetime` values that live until the call
		// returns.
		let ok = unsafe {
			GetProcessTimes(handle, &raw mut creation, &raw mut exit, &raw mut kernel, &raw mut user)
				!= 0
		};
		if !ok {
			return None;
		}
		Some((u64::from(creation.dw_high_date_time) << 32) | u64::from(creation.dw_low_date_time))
	}

	fn read_remote<T: Copy>(handle: Handle, address: usize) -> Option<T> {
		if address == 0 {
			return None;
		}
		let mut value = mem::MaybeUninit::<T>::uninit();
		let mut bytes_read = 0usize;
		// SAFETY: `handle` is opened with `PROCESS_VM_READ`. `address` comes from
		// kernel-reported process structures for that same process. `value`
		// points to uninitialized local storage large enough for `T`, and
		// `bytes_read` is a valid out-parameter. The value is only assumed
		// initialized after the OS reports a full-size successful read.
		let ok = unsafe {
			ReadProcessMemory(
				handle,
				address as *const c_void,
				value.as_mut_ptr().cast::<c_void>(),
				mem::size_of::<T>(),
				&raw mut bytes_read,
			) != 0
		};
		if ok && bytes_read == mem::size_of::<T>() {
			// SAFETY: The successful `ReadProcessMemory` call above initialized
			// exactly `size_of::<T>()` bytes in `value`.
			Some(unsafe { value.assume_init() })
		} else {
			None
		}
	}

	fn read_remote_unicode_string(handle: Handle, value: UnicodeString) -> Option<String> {
		if value.length == 0 || value.buffer == 0 || !value.length.is_multiple_of(2) {
			return None;
		}
		let code_units = usize::from(value.length) / size_of::<u16>();
		let mut buffer = vec![0u16; code_units];
		let mut bytes_read = 0usize;
		// SAFETY: `handle` is opened with `PROCESS_VM_READ`. `value.buffer` and
		// `value.length` come from the remote process' own `UNICODE_STRING`.
		// `buffer` is writable for exactly `value.length` bytes, and
		// `bytes_read` is a valid out-parameter. The string is decoded only
		// after a full successful read.
		let ok = unsafe {
			ReadProcessMemory(
				handle,
				value.buffer as *const c_void,
				buffer.as_mut_ptr().cast::<c_void>(),
				usize::from(value.length),
				&raw mut bytes_read,
			) != 0
		};
		if ok && bytes_read == usize::from(value.length) {
			Some(String::from_utf16_lossy(&buffer))
		} else {
			None
		}
	}

	fn split_windows_command_line(command_line: &str) -> Vec<String> {
		use std::os::windows::ffi::OsStringExt;

		let mut wide: Vec<u16> = command_line.encode_utf16().chain([0]).collect();
		let mut argc = 0i32;
		// SAFETY: `wide` is a local, NUL-terminated UTF-16 buffer that remains
		// alive for the duration of the call. `argc` is a valid out-parameter.
		// The returned argv block is released with `LocalFree` below as
		// required by `CommandLineToArgvW`.
		let argv = unsafe { CommandLineToArgvW(wide.as_mut_ptr(), &raw mut argc) };
		if argv.is_null() || argc <= 0 {
			return Vec::new();
		}
		let argc = argc as usize;
		// SAFETY: `CommandLineToArgvW` returned a non-null pointer to `argc`
		// argument pointers, valid until freed with `LocalFree`.
		let pointers = unsafe { std::slice::from_raw_parts(argv, argc) };
		let args = pointers
			.iter()
			.filter_map(|&arg| {
				if arg.is_null() {
					return None;
				}
				let mut len = 0usize;
				// SAFETY: Each pointer in the argv block is a NUL-terminated UTF-16
				// string owned by the argv block and valid until `LocalFree` below.
				while unsafe { *arg.add(len) } != 0 {
					len += 1;
				}
				// SAFETY: The loop above found the terminating NUL, so the
				// preceding `len` code units form a valid readable slice.
				let slice = unsafe { std::slice::from_raw_parts(arg, len) };
				Some(
					std::ffi::OsString::from_wide(slice)
						.to_string_lossy()
						.into_owned(),
				)
			})
			.collect();
		// SAFETY: `argv` is the allocation returned by `CommandLineToArgvW` and
		// has not been freed yet. No pointers into it are used after this call.
		let _ = unsafe { LocalFree(argv.cast::<c_void>()) };
		args
	}

	fn open_process(pid: u32, access: u32) -> Option<Arc<OwnedHandle>> {
		// SAFETY: `OpenProcess` takes the PID and access mask by value and does
		// not dereference caller-owned memory. Handle inheritance is disabled.
		// Identity is established by the caller (typically `Process::from_pid`)
		// capturing the creation time immediately after a successful open and
		// re-checking it on every subsequent operation that re-resolves the
		// PID.
		let handle = unsafe { OpenProcess(access, 0, pid) };
		OwnedHandle::from_raw(handle).map(Arc::new)
	}

	fn create_process_snapshot() -> Option<OwnedHandle> {
		// SAFETY: The process snapshot API takes flags and a process ID by value
		// and does not dereference caller-owned memory. PID zero requests all
		// processes.
		let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
		OwnedHandle::from_raw(snapshot)
	}

	const fn process_entry() -> PROCESSENTRY32W {
		PROCESSENTRY32W {
			dwSize:              mem::size_of::<PROCESSENTRY32W>() as u32,
			cntUsage:            0,
			th32ProcessID:       0,
			th32DefaultHeapID:   0,
			th32ModuleID:        0,
			cntThreads:          0,
			th32ParentProcessID: 0,
			pcPriClassBase:      0,
			dwFlags:             0,
			szExeFile:           [0; 260],
		}
	}

	/// Build a map of `parent_pid` -> [`child_pids`] for all processes.
	fn build_process_tree() -> HashMap<u32, SmallVec<[u32; 4]>> {
		let mut tree: HashMap<u32, SmallVec<[u32; 4]>> = HashMap::new();
		let Some(snapshot) = create_process_snapshot() else {
			return tree;
		};

		let mut entry = process_entry();
		// SAFETY: `snapshot` is a valid Toolhelp snapshot handle. `entry` points
		// to a writable `PROCESSENTRY32W` whose `dwSize` field was initialized
		// to the exact ABI size before the call.
		if unsafe { Process32FirstW(snapshot.as_raw(), &raw mut entry) } == 0 {
			return tree;
		}

		loop {
			tree
				.entry(entry.th32ParentProcessID)
				.or_default()
				.push(entry.th32ProcessID);

			// SAFETY: `snapshot` remains a valid Toolhelp snapshot handle, and
			// `entry` remains a writable `PROCESSENTRY32W` with its ABI size
			// preserved.
			if unsafe { Process32NextW(snapshot.as_raw(), &raw mut entry) } == 0 {
				break;
			}
		}

		tree
	}

	/// Process groups are not exposed on Windows.
	/// Always returns `false`.
	pub const fn kill_process_group(_pgid: i32, _signal: i32) -> bool {
		false
	}

	/// Reading another process's environment needs its PEB; not implemented.
	pub fn scan_processes_by_env(
		_name: &str,
		_tokens: &[&str],
		_opaque_since: Option<u64>,
	) -> super::MarkedProcessScan {
		super::MarkedProcessScan::default()
	}

	/// Find processes whose `QueryFullProcessImageNameW` result equals `target`.
	pub fn find_by_path(target: &str) -> Vec<Process> {
		use std::{ffi::OsString, os::windows::ffi::OsStringExt};

		let mut matches = Vec::new();
		let Some(snapshot) = create_process_snapshot() else {
			return matches;
		};

		let mut entry = process_entry();
		let mut buf = vec![0u16; 32_768];
		let target = OsString::from(target);

		// SAFETY: `snapshot` is a valid Toolhelp snapshot handle. `entry` points
		// to a writable `PROCESSENTRY32W` whose `dwSize` field was initialized
		// to the exact ABI size before the call.
		if unsafe { Process32FirstW(snapshot.as_raw(), &raw mut entry) } == 0 {
			return matches;
		}

		loop {
			let pid = entry.th32ProcessID;
			if let Some(handle) = open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION) {
				let mut size = buf.len() as u32;
				// SAFETY: `handle` was opened with query access and remains valid
				// for the call. `buf` is writable for `size` UTF-16 code units,
				// and `size` is a valid in/out parameter initialized to that
				// capacity.
				let ok = unsafe {
					QueryFullProcessImageNameW(handle.as_raw(), 0, buf.as_mut_ptr(), &raw mut size) != 0
				};
				if ok {
					let path = OsString::from_wide(&buf[..size as usize]);
					if path == target
						&& let Some(process) = Process::from_pid(i32::try_from(pid).unwrap_or_default())
					{
						matches.push(process);
					}
				}
			}

			// SAFETY: `snapshot` remains a valid Toolhelp snapshot handle, and
			// `entry` remains a writable `PROCESSENTRY32W` with its ABI size
			// preserved.
			if unsafe { Process32NextW(snapshot.as_raw(), &raw mut entry) } == 0 {
				break;
			}
		}

		matches
	}
}

/// Whether a pid names a live process; see [`ProcessIdentity`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentityState {
	/// The process exists and is not a zombie.
	Running,
	/// No such process, or only a zombie/dead entry remains.
	Gone,
	/// The process exists (or cannot be proven gone) but its identity cannot
	/// be read: permission denied, `hidepid`, non-dumpable, …
	Unreadable,
}

/// Clock-independent identity of a process at one moment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcessIdentity {
	pub state:      IdentityState,
	/// Opaque start identity, `Some` exactly when `state` is `Running`; see
	/// [`Process::start_id`]. Equal values on one host and boot mean the same
	/// process; values of one host and boot also order by start.
	pub start_id:   Option<u64>,
	/// Display only: start time in Unix epoch seconds (floor), when running
	/// and readable.
	pub start_time: Option<u64>,
}

impl ProcessIdentity {
	const GONE: Self = Self { state: IdentityState::Gone, start_id: None, start_time: None };
	const UNREADABLE: Self =
		Self { state: IdentityState::Unreadable, start_id: None, start_time: None };

	const fn running(start_id: u64, start_time: Option<u64>) -> Self {
		Self { state: IdentityState::Running, start_id: Some(start_id), start_time }
	}
}

/// Current identity of `pid`.
///
/// Running with its start id, gone (no such process, or a zombie), or
/// unreadable (present but its start cannot be read). Unlike
/// [`Process::from_pid`], a read failure is never mistaken for the process
/// having exited.
#[must_use]
pub fn process_identity(pid: i32) -> ProcessIdentity {
	if pid <= 0 {
		return ProcessIdentity::GONE;
	}
	platform::process_identity(pid)
}

/// `Unreadable` when `pid` still exists — `kill(pid, 0)` succeeds or is
/// refused with `EPERM` — else `Gone`. For callers that could not read the
/// process at all.
#[cfg(unix)]
fn unreadable_unless_gone(pid: i32) -> ProcessIdentity {
	// SAFETY: `kill` takes integers by value; signal 0 only probes existence
	// and permission.
	let exists = unsafe { libc::kill(pid, 0) } == 0
		|| std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
	if exists {
		ProcessIdentity::UNREADABLE
	} else {
		ProcessIdentity::GONE
	}
}

/// A live process whose environment carries a marker token; see
/// [`scan_processes_by_env`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkedProcess {
	pub pid:        i32,
	pub ppid:       i32,
	/// Process group id when readable.
	pub pgid:       Option<i32>,
	/// OS start time, Unix epoch seconds (floor) — the value
	/// [`process_identity`] reports as `start_time` for the same process.
	pub start_time: Option<u64>,
	/// Opaque start identity — the value [`process_identity`] reports for
	/// the same process.
	pub start_id:   Option<u64>,
	/// Executable name (best effort, may be truncated by the OS).
	pub command:    String,
	/// The first of the requested tokens the process carries; `None` for
	/// [`MarkedProcessScan::opaque`] entries.
	pub token:      Option<String>,
}

impl MarkedProcess {
	/// A process known only by its pid.
	#[cfg(unix)]
	const fn unidentified(pid: i32) -> Self {
		Self {
			pid,
			ppid: 0,
			pgid: None,
			start_time: None,
			start_id: None,
			command: String::new(),
			token: None,
		}
	}
}

/// Result of [`scan_processes_by_env`].
#[derive(Debug, Default)]
pub struct MarkedProcessScan {
	/// False on platforms without an implementation (Windows): the result is
	/// unknown, not empty.
	pub supported:  bool,
	/// True when the platform may hide processes of this user from the scan
	/// altogether: Linux `/proc` mounted with `hidepid` other than `0`/`off`
	/// (or whose mount options cannot be read). Such a scan is not a complete
	/// census, whatever `opaque` says.
	pub hidden:     bool,
	pub processes:  Vec<MarkedProcess>,
	/// Live candidate processes examined (zombies excluded): those whose real,
	/// effective or saved uid is the caller's, or whose uids cannot be read.
	pub scanned:    u32,
	/// Live candidates whose environment (or, on Linux, `stat`; on macOS,
	/// full process info) could not be read. Processes that exited mid-scan
	/// are not counted.
	pub unreadable: u32,
	/// Live candidates whose environment came back empty. On macOS the kernel
	/// returns no environment for Apple platform binaries (`/bin/sh`, `zsh`,
	/// `sleep`, …), so a marker on such a process is invisible and lands here;
	/// a process started with an empty environment is counted too.
	pub redacted:   u32,
	/// The unreadable and redacted processes whose start id is at or after the
	/// caller's `opaque_since`, or unknown (empty when no `opaque_since` was
	/// given): the ones that could carry a marker set no earlier than that
	/// instant without the scan seeing it.
	pub opaque:     Vec<MarkedProcess>,
}

impl MarkedProcessScan {
	#[cfg(unix)]
	fn push_opaque(&mut self, entry: MarkedProcess, since: Option<u64>) {
		if let Some(since) = since
			&& entry.start_id.is_none_or(|start| start >= since)
		{
			self.opaque.push(entry);
		}
	}
}

/// Live processes found in some process groups; see
/// [`platform::list_group_members`].
#[derive(Debug, Default)]
struct GroupListing {
	/// `(pid, pgid)` of each live member.
	members: Vec<(i32, i32)>,
	/// The groups any listed process, zombies included, belongs to. A live
	/// group missing here has a member the listing could not see.
	seen:    HashSet<i32>,
	/// A live process's group could not be read, or the platform may hide
	/// processes from the listing: `members` may be missing some.
	partial: bool,
}

/// Every live process of the calling user, except the caller itself, whose
/// environment variable `name`, split on `,`, holds one of `tokens` exactly.
///
/// A process is the user's when its real, effective or saved uid is the
/// caller's real or effective uid (a setuid launch keeps the caller's as its
/// real uid); one whose uids cannot be read is examined too. No tokens match
/// nothing.
///
/// Environments are read as the kernel exposes them: the block the process
/// was exec'd with, not later `setenv` changes.
///
/// `opaque_since` is a start id ([`ProcessIdentity::start_id`] of this host
/// and boot: Linux start ticks, macOS start microseconds) selecting which
/// processes whose environment could not be examined are listed in
/// [`MarkedProcessScan::opaque`]: those whose start id is at or after it (or
/// unknown). A marker set at that instant cannot be inherited by an older
/// process, so only these can hide one.
#[must_use]
pub fn scan_processes_by_env(
	name: &str,
	tokens: &[&str],
	opaque_since: Option<u64>,
) -> MarkedProcessScan {
	platform::scan_processes_by_env(name, tokens, opaque_since)
}

/// The caller's real and effective uid: the ids a process of this user runs
/// under in at least one of its uid slots.
#[cfg(unix)]
fn own_uids() -> [libc::uid_t; 2] {
	// SAFETY: `getuid`/`geteuid` take no arguments and cannot fail.
	unsafe { [libc::getuid(), libc::geteuid()] }
}

/// True when any of a process's real, effective and saved uids is one of
/// `ours`.
#[cfg(unix)]
fn uid_candidate(ids: [libc::uid_t; 3], ours: [libc::uid_t; 2]) -> bool {
	ids.iter().any(|id| ours.contains(id))
}

/// The first of `tokens` (in their order) among the comma-separated elements
/// of the first `name=` entry of `env` (getenv semantics).
#[cfg(any(unix, test))]
fn env_marker_token<'a, 't>(
	env: impl IntoIterator<Item = &'a [u8]>,
	name: &str,
	tokens: &[&'t str],
) -> Option<&'t str> {
	let name = name.as_bytes();
	let value = env
		.into_iter()
		.find_map(|entry| entry.strip_prefix(name)?.strip_prefix(b"="))?;
	tokens.iter().copied().find(|token| {
		value
			.split(|byte| *byte == b',')
			.any(|element| element == token.as_bytes())
	})
}

/// Stable process reference.
#[derive(Clone)]
pub struct Process {
	inner: platform::Process,
}

impl Process {
	/// Open a stable process reference from a PID.
	pub fn from_pid(pid: i32) -> Option<Self> {
		platform::Process::from_pid(pid).map(Self::from_inner)
	}

	/// Open stable process references whose executable path matches exactly.
	pub fn from_path(path: String) -> Vec<Self> {
		platform::find_by_path(&path)
			.into_iter()
			.map(Self::from_inner)
			.collect()
	}

	/// Operating-system process identifier for this process reference.
	#[must_use]
	pub const fn pid(&self) -> i32 {
		self.inner.pid()
	}

	/// OS start time of this process in Unix epoch seconds (floor), as pinned
	/// when the reference was opened — the instant `ps -o lstart` prints.
	#[must_use]
	#[allow(
		clippy::missing_const_for_fn,
		reason = "const only on macOS; Linux reads /proc and Windows converts FILETIME"
	)]
	pub fn start_time_unix_secs(&self) -> Option<u64> {
		self.inner.start_time_unix_secs()
	}

	/// Opaque start identity pinned when the reference was opened — the value
	/// [`process_identity`] reports as `start_id`: Linux `/proc/<pid>/stat`
	/// start ticks since boot, macOS start microseconds, Windows creation
	/// `FILETIME`. Independent of wall-clock changes.
	#[must_use]
	pub const fn start_id(&self) -> u64 {
		self.inner.start_id()
	}

	/// Parent process id for this process, when available.
	#[must_use]
	pub fn ppid(&self) -> Option<i32> {
		self.inner.parent_pid()
	}

	/// Launch arguments for this process.
	#[must_use]
	pub fn args(&self) -> Vec<String> {
		self.inner.args()
	}

	/// Send `signal` to this process and its descendants, children first.
	///
	/// On Linux and macOS the signal is forwarded as-is. On Windows there is no
	/// signal abstraction, so the `signal` argument is ignored and the entire
	/// tree is hard-killed via `TerminateProcess`. Defaults to the POSIX
	/// hard-kill signal.
	#[must_use]
	pub fn kill_tree(&self, signal: Option<i32>) -> u32 {
		self.signal_tree(signal.unwrap_or(KILL_SIGNAL))
	}

	/// Process group id for this process, when supported by the platform.
	#[cfg(target_os = "windows")]
	#[must_use]
	pub const fn group_id(&self) -> Option<i32> {
		platform::Process::group_id()
	}

	#[cfg(not(target_os = "windows"))]
	#[must_use]
	pub fn group_id(&self) -> Option<i32> {
		self.inner.group_id()
	}

	/// Direct children of this process as stable process references.
	pub fn children(&self) -> Vec<Self> {
		self
			.inner
			.children()
			.into_iter()
			.map(Self::from_inner)
			.collect()
	}

	/// Current status of this process reference.
	#[must_use]
	pub fn status(&self) -> ProcessStatus {
		self.inner.status()
	}

	/// Gracefully terminate this process and its descendants.
	///
	/// Sends `TERM_SIGNAL` to the optional process group, every live descendant,
	/// and the root, then optionally waits up to `graceful_ms` for the tree to
	/// exit before escalating to `KILL_SIGNAL`. Pass `graceful_ms < 0` to skip
	/// the wait entirely (the polite signal is still emitted). Returns `true`
	/// when the tree has exited by the end of the hard wave's wait window.
	pub async fn terminate_tree(
		&self,
		group: bool,
		graceful_ms: i32,
		timeout_ms: u32,
		ct: CancelToken,
	) -> Result<bool> {
		self
			.terminate_tree_impl(group, graceful_ms, timeout_ms, ct)
			.await
	}

	/// Wait until this process exits, optionally bounded by `timeout`.
	pub async fn wait_for_exit(&self, timeout: Option<Duration>, ct: CancelToken) -> Result<bool> {
		wait_for_exit(self, &[], timeout, ct).await
	}
}

impl Process {
	const fn from_inner(inner: platform::Process) -> Self {
		Self { inner }
	}

	/// Walk the live descendant tree from scratch. Cheap and idempotent — call
	/// it again before each signal wave so grandchildren spawned during a grace
	/// period are not missed.
	fn live_descendants(&self) -> Vec<Self> {
		self
			.inner
			.descendants()
			.into_iter()
			.map(Self::from_inner)
			.collect()
	}

	fn signal_tree(&self, signal: i32) -> u32 {
		self.signal_tree_excluding(signal, &host_protected_pids())
	}

	/// Signal this process and its live descendants (children first), skipping
	/// any pid in `protected`.
	///
	/// `protected` shields the harness itself: a run-cancellation sweep must
	/// never hard-kill the host. On Windows the
	/// descendant tree is derived from raw `th32ParentProcessID` values that
	/// outlive their recorded parent, so a freshly spawned child whose recycled
	/// pid matches the harness's stale parent pid makes the harness enumerate
	/// as a false descendant; `TerminateProcess`-ing it drops the whole session
	/// with no cleanup and no `session_exit` record (#7452, related #4605).
	fn signal_tree_excluding(&self, signal: i32, protected: &HashSet<i32>) -> u32 {
		let descendants = self.signalable_descendants(protected);
		let mut signaled = 0u32;
		// If self leads its own process group, also signal the group — this
		// catches grandchildren reparented to init when their immediate parent
		// died inside the descendant walk.
		if let Some(pgid) = self.group_id()
			&& pgid == self.inner.pid()
		{
			let _ = kill_process_group(pgid, signal);
		}
		for child in &descendants {
			if child.inner.kill(signal) {
				signaled += 1;
			}
		}
		if !protected.contains(&self.pid()) && self.inner.kill(signal) {
			signaled += 1;
		}
		signaled
	}

	/// Live descendants with every protected subtree pruned, not just the exact
	/// protected pids.
	///
	/// The flattened descendant list can contain a protected node (the harness,
	/// on a Windows PID-reuse false-descendant) *together with* that node's real
	/// children, which were collected by recursing through it. Skipping only the
	/// exact protected pid would still terminate those unrelated worker/tool
	/// subprocesses, so drop every node whose recorded parent chain — within the
	/// enumerated set — passes through a protected pid (#7452 review).
	fn signalable_descendants(&self, protected: &HashSet<i32>) -> Vec<Self> {
		let descendants = self.live_descendants();
		let parents: HashMap<i32, i32> = descendants
			.iter()
			.filter_map(|descendant| descendant.ppid().map(|parent| (descendant.pid(), parent)))
			.collect();
		descendants
			.into_iter()
			.filter(|descendant| !pid_in_protected_subtree(descendant.pid(), protected, &parents))
			.collect()
	}

	async fn terminate_tree_impl(
		&self,
		group: bool,
		graceful_ms: i32,
		timeout_ms: u32,
		ct: CancelToken,
	) -> Result<bool> {
		if self.status() != ProcessStatus::Running {
			return Ok(true);
		}

		let process_group = if group { self.group_id() } else { None };
		let protected = host_protected_pids();

		// Polite wave: SIGTERM the group, every live descendant, then the root.
		if let Some(pgid) = process_group {
			let _ = kill_process_group(pgid, TERM_SIGNAL);
		}
		let mut descendants = self.signalable_descendants(&protected);
		for child in &descendants {
			let _ = child.inner.kill(TERM_SIGNAL);
		}
		if !protected.contains(&self.pid()) {
			let _ = self.inner.kill(TERM_SIGNAL);
		}

		// Optional grace wait. A negative `graceful_ms` skips the wait entirely
		// (we still emit the polite signal so cleanup handlers can run before
		// KILL).
		if graceful_ms >= 0 {
			let exited = wait_for_exit(
				self,
				&descendants,
				Some(Duration::from_millis(graceful_ms as u64)),
				ct.clone(),
			)
			.await?;
			if exited {
				return Ok(true);
			}
		}

		// Hard wave. Re-walk the tree so any grandchild spawned during the grace
		// period — or any process re-parented to the root — is signalled too.
		if let Some(pgid) = process_group {
			let _ = kill_process_group(pgid, KILL_SIGNAL);
		}
		descendants = self.signalable_descendants(&protected);
		for child in &descendants {
			let _ = child.inner.kill(KILL_SIGNAL);
		}
		if !protected.contains(&self.pid()) {
			let _ = self.inner.kill(KILL_SIGNAL);
		}

		wait_for_exit(self, &descendants, Some(Duration::from_millis(u64::from(timeout_ms))), ct)
			.await
	}
}

/// The harness pid — the one process a run-cancellation sweep must never
/// signal.
///
/// On Unix the descendant walk is identity-pinned (pidfd / start-time), so the
/// host can never appear as a false descendant and this set is a harmless
/// no-op safety net. On Windows the descendant tree is derived from raw
/// `th32ParentProcessID` values that survive their recorded parent's death: a
/// freshly spawned child whose recycled pid matches the harness's stale parent
/// pid makes the harness enumerate as a false descendant, so cancelling a
/// timed-out bash run would `TerminateProcess` the host with no cleanup and no
/// `session_exit` record (#7452, related #4605).
///
/// Do not walk the host's numeric parent chain here. On Windows the host's
/// recorded parent pid can itself have been recycled onto the cancellation
/// target; treating that raw pid as protected would spare the hung command and
/// prune all of its descendants from cleanup.
fn host_protected_pids() -> HashSet<i32> {
	i32::try_from(std::process::id()).into_iter().collect()
}

/// True when `pid` is itself protected or descends — within the enumerated
/// `parents` map (pid -> recorded parent pid) — from a protected pid. Used to
/// prune a whole protected subtree from a cancellation sweep so a false
/// descendant of the harness cannot drag the harness's real children into the
/// kill set (#7452).
fn pid_in_protected_subtree(
	pid: i32,
	protected: &HashSet<i32>,
	parents: &HashMap<i32, i32>,
) -> bool {
	let mut current = pid;
	// Bound the walk against a corrupted or cyclic parent chain.
	for _ in 0..256 {
		if protected.contains(&current) {
			return true;
		}
		match parents.get(&current) {
			Some(&parent) if parent != current => current = parent,
			_ => return false,
		}
	}
	false
}

async fn wait_for_exit(
	root: &Process,
	descendants: &[Process],
	timeout: Option<Duration>,
	ct: CancelToken,
) -> Result<bool> {
	ct.heartbeat()?;
	if root.status() != ProcessStatus::Running
		&& descendants
			.iter()
			.all(|process| process.status() != ProcessStatus::Running)
	{
		return Ok(true);
	}

	let poll_interval = Duration::from_millis(50);
	let mut elapsed = Duration::ZERO;
	while timeout.is_none_or(|limit| elapsed < limit) {
		let sleep_for =
			timeout.map_or(poll_interval, |limit| limit.saturating_sub(elapsed).min(poll_interval));
		if sleep_for.is_zero() {
			break;
		}
		ct.heartbeat()?;
		tokio::time::sleep(sleep_for).await;
		elapsed += sleep_for;

		if root.status() != ProcessStatus::Running
			&& descendants
				.iter()
				.all(|process| process.status() != ProcessStatus::Running)
		{
			return Ok(true);
		}
	}

	Ok(false)
}

/// Send `signal` to the process group `pgid`.
/// Returns false when process groups are unsupported on the platform.
#[allow(clippy::missing_const_for_fn, reason = "Dispatches to platform-specific implementation")]
#[must_use]
pub fn kill_process_group(pgid: i32, signal: i32) -> bool {
	// Defense in depth: refuse to deliver a signal to the harness's own
	// process group. Doing so terminates the harness along with the targets.
	// `SpawnRegistry` only ever records pgids brush created for this run (never
	// the harness pgid); this catches any future caller that bypasses it.
	if pgid <= 0 || is_self_process_group(pgid) {
		return false;
	}
	platform::kill_process_group(pgid, signal)
}

#[cfg(unix)]
fn is_self_process_group(pgid: i32) -> bool {
	// SAFETY: `getpgid(0)` queries the calling process's pgid and does not
	// access caller-owned memory. A return value <= 0 is treated as "unknown",
	// which fails open so the actual signal call decides.
	let self_pgid = unsafe { libc::getpgid(0) };
	self_pgid > 0 && self_pgid == pgid
}

#[cfg(not(unix))]
const fn is_self_process_group(_pgid: i32) -> bool {
	false
}

/// POSIX `SIGTERM` / Windows polite termination sentinel.
pub const TERM_SIGNAL: i32 = 15;

/// POSIX `SIGKILL` / Windows hard-termination sentinel.
pub const KILL_SIGNAL: i32 = 9;

/// A collection of process groups and process trees scheduled for
/// termination together.
///
/// Built incrementally from job records or PTY metadata, then signalled
/// in escalating waves (typically `TERM_SIGNAL` followed by
/// `KILL_SIGNAL` after a grace period). Process-group calls are no-ops
/// on platforms that do not expose process groups.
#[derive(Default)]
pub struct TerminationTargets {
	pgids:     Vec<i32>,
	processes: Vec<Process>,
	seen_pids: HashSet<i32>,
}

impl TerminationTargets {
	/// Create an empty target set.
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}

	/// Record a process group id. Duplicates are ignored.
	pub fn add_pgid(&mut self, pgid: i32) {
		if pgid > 0 && !self.pgids.contains(&pgid) {
			self.pgids.push(pgid);
		}
	}

	/// Record a pid. Duplicates are ignored. If the pid is alive, opens
	/// a stable [`Process`] reference so the descendant tree can be
	/// killed even if the original pid is reused later.
	///
	/// Prefer [`add_process`](Self::add_process) when the caller already holds a
	/// [`Process`] captured at spawn time: opening by pid here loses the
	/// original identity if the pid was recycled between the child exiting
	/// and this call.
	pub fn add_pid(&mut self, pid: i32) {
		if self.seen_pids.insert(pid)
			&& let Some(process) = Process::from_pid(pid)
		{
			self.processes.push(process);
		}
	}

	/// Record a pre-pinned [`Process`] handle. Duplicates (by pid) are ignored.
	///
	/// This is the correct entry point when the caller captured the handle at
	/// spawn time — the handle already pins OS-level identity, so no `from_pid`
	/// re-open (and its PID-reuse race) is needed at cancellation time.
	pub fn add_process(&mut self, process: Process) {
		if self.seen_pids.insert(process.pid()) {
			self.processes.push(process);
		}
	}

	/// True when no targets have been recorded.
	#[must_use]
	pub const fn is_empty(&self) -> bool {
		self.pgids.is_empty() && self.processes.is_empty()
	}

	/// Send `signal` to every recorded target. Failures are swallowed:
	/// targets routinely exit between collection and signalling, and
	/// the caller's policy is "best effort".
	pub fn signal(&self, signal: i32) {
		for &pgid in &self.pgids {
			let _ = kill_process_group(pgid, signal);
		}
		for process in &self.processes {
			let _ = process.signal_tree(signal);
		}
	}
}

/// A single external child reported by the shell's spawn-observer hook.
///
/// `process` is captured *at spawn time* so its OS-level identity is pinned
/// before the pid can be recycled. On Windows an open process handle keeps
/// the pid reserved for the lifetime of the reference; on Linux the pidfd
/// pins identity; on macOS the recorded `(pid, start_time)` triple detects
/// impersonation. Storing only the raw pid and re-opening at cancellation
/// time — as previous versions did — leaked kills onto unrelated processes
/// that happened to acquire the recycled pid between the child exiting and
/// the run being cancelled (issue #4605).
#[derive(Clone)]
struct OwnedSpawn {
	process: Option<Process>,
	pgid:    Option<i32>,
}

/// The real process of a reparented launch (`nohup cmd &`), identity-pinned at
/// report time. Informational only: never part of the teardown set.
#[derive(Clone)]
struct ReparentedSpawn {
	process: Process,
	pgid:    Option<i32>,
}

/// A launched process whose identity could not be pinned although it had not
/// provably exited. Reported by raw pid, without a start identity, and makes
/// the run's survivor list incomplete while the pid is still in use.
#[derive(Clone, Copy)]
struct UnpinnedSpawn {
	pid:        i32,
	pgid:       Option<i32>,
	reparented: bool,
}

/// A process a shell run launched that was still alive when the run resolved.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SpawnedProcess {
	/// OS process id.
	pub pid:          i32,
	/// Process group id when known; for reparented launches the detached
	/// session/process-group id.
	pub pgid:         Option<i32>,
	/// OS start time in Unix epoch seconds (floor), pinned when the process
	/// was recorded. `None` when the process could not be identity-pinned.
	pub start_time:   Option<u64>,
	/// Opaque start identity ([`Process::start_id`]) pinned when the process
	/// was recorded. `None` when the process could not be identity-pinned.
	#[serde(default)]
	pub start_id:     Option<u64>,
	/// True for the real process of a reparented launch (e.g. `nohup cmd &`).
	pub reparented:   bool,
	/// True for a live same-user member of a process group an owned spawn
	/// created, found by enumerating the group rather than reported at spawn
	/// (e.g. the sleep `sh -c '/bin/sleep 60 &'` leaves in the dead sh's group).
	#[serde(default)]
	pub group_member: bool,
}

/// What [`SpawnRegistry::survivors`] found.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Survivors {
	pub processes: Vec<SpawnedProcess>,
	/// False when the run may have left a process `processes` does not name:
	/// a launch could not be identity-pinned, a reparented launch went
	/// unreported, or process-group enumeration failed.
	pub complete:  bool,
}

/// Per-run record of the OS processes a single shell command launched,
/// captured at spawn time via brush's `SpawnObserver` hook.
///
/// Replaces the old process-global "new descendants since a baseline" diff,
/// which could not distinguish the children of concurrent runs sharing one
/// host process: a run that cancelled would signal *any* descendant spawned
/// after its baseline, including another run's children. Ownership is now
/// explicit — only processes this run actually spawned are ever signalled.
#[derive(Default)]
struct RegistryState {
	spawned:                  Vec<OwnedSpawn>,
	/// The next `spawned.len()` at which `record` runs a sweep. Bounds sweep
	/// frequency when the live set stabilizes above the initial threshold:
	/// without this watermark, every subsequent `record` would find
	/// `len >= PRUNE_THRESHOLD` true and sweep on every spawn (O(n²) in a
	/// large-fan-out run like `for i in {1..1000}; do sleep 60 & done`). With
	/// it, the next sweep only fires once the vec has grown by another
	/// `PRUNE_THRESHOLD` entries since the previous sweep — restoring true
	/// amortized O(1) per spawn regardless of how many entries survive each
	/// sweep.
	next_sweep_at:            usize,
	/// Reparented launches' real processes. Kept apart from `spawned` so they
	/// never reach [`SpawnRegistry::build_targets`].
	reparented:               Vec<ReparentedSpawn>,
	/// Sweep watermark for `reparented`, same scheme as `next_sweep_at`.
	next_reparented_sweep_at: usize,
	/// Launches that could not be identity-pinned but had not provably exited.
	unpinned:                 Vec<UnpinnedSpawn>,
	/// Process groups owned spawns created (each led by the spawn's pid),
	/// enumerated for leftover members when the run resolves.
	groups:                   HashSet<i32>,
	/// A launch whose real process was never reported (e.g. a reparented
	/// launch whose report pipe was clobbered).
	unreported:               bool,
}

#[derive(Default)]
pub struct SpawnRegistry {
	state: Mutex<RegistryState>,
}

impl SpawnRegistry {
	/// Amortized-cost threshold for opportunistic pruning of exited entries.
	///
	/// A shell run that spawns many short-lived external commands (e.g. a bash
	/// loop invoking a binary per iteration) would otherwise retain one owned
	/// process handle per spawn — a pidfd on Linux, a `HANDLE` on Windows — for
	/// the lifetime of the run, exhausting per-process FD/handle limits.
	///
	/// Each sweep costs `O(N)` (one non-blocking status probe per entry, plus
	/// a Toolhelp descendant walk on Windows for exited roots). The next sweep
	/// is scheduled `PRUNE_THRESHOLD` further records away — via the
	/// `next_sweep_at` watermark — so a run that keeps many concurrent
	/// long-lived children (`for i in {1..1000}; do sleep 60 & done`) does not
	/// sweep on every spawn just because the vec is already above threshold.
	/// Amortized cost per spawn stays `O(1)` regardless of the live-set size.
	const PRUNE_THRESHOLD: usize = 64;

	/// Create an empty registry.
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}

	/// Record a freshly spawned child. Called from the spawn-observer hook.
	///
	/// The `Process` handle MUST be opened by the caller *immediately* after
	/// the child's pid becomes visible, so identity is pinned before any race
	/// with pid recycling can start. When the pin fails the entry is a no-op at
	/// termination time; unless `pid` has provably exited, it is also kept as
	/// an unpinned survivor that makes [`SpawnRegistry::survivors`] incomplete.
	///
	/// Exited entries are swept opportunistically once the recorded vec
	/// crosses the next-sweep watermark, so long-running loops of short
	/// external commands cannot exhaust the process' FD/handle limit by
	/// retaining one owned handle per historical spawn.
	pub fn record(&self, pid: i32, pgid: Option<i32>, process: Option<Process>) {
		let unpinned = process.is_none() && !is_gone(pid);
		let group = created_group(pid, pgid);
		let mut state = self.state.lock();
		if unpinned {
			state
				.unpinned
				.push(UnpinnedSpawn { pid, pgid, reparented: false });
		}
		if let Some(group) = group {
			state.groups.insert(group);
		}
		state.spawned.push(OwnedSpawn { process, pgid });
		if state.spawned.len() >= state.next_sweep_at.max(Self::PRUNE_THRESHOLD) {
			prune_exited(&mut state.spawned);
			state.groups.retain(|group| process_group_alive(*group));
			// Schedule the next sweep `PRUNE_THRESHOLD` further records away.
			// Comparing against the post-sweep live-set size (not the pre-sweep
			// length) bounds the sweep frequency when many entries survive:
			// each sweep costs O(N) but now runs at most once per
			// `PRUNE_THRESHOLD` records, so amortized per-record cost is O(1)
			// even if the live set stays large.
			state.next_sweep_at = state.spawned.len() + Self::PRUNE_THRESHOLD;
		}
	}

	/// Record the real process of a reparented launch (`nohup cmd &`). Called
	/// from the spawn-observer hook right after the launch, so identity is
	/// pinned before the pid can be recycled; a process that already exited is
	/// dropped. These entries are reported by [`SpawnRegistry::survivors`] but
	/// never signalled: reparented launches must outlive the run's teardown.
	///
	/// The launch's process group (for a double-forked launch, the detached
	/// session's) is enumerated like an owned spawn's, so a process the launch
	/// leaves in it (`nohup sh -c 'cmd &' &`) is reported too.
	pub fn record_reparented(&self, pid: i32, pgid: Option<i32>, process: Option<Process>) {
		let group = pgid.filter(|pgid| *pgid > 0 && !is_self_process_group(*pgid));
		let unpinned = process.is_none() && !is_gone(pid);
		let mut state = self.state.lock();
		if let Some(group) = group {
			state.groups.insert(group);
		}
		let Some(process) = process else {
			if unpinned {
				state
					.unpinned
					.push(UnpinnedSpawn { pid, pgid, reparented: true });
			}
			return;
		};
		state.reparented.push(ReparentedSpawn { process, pgid });
		if state.reparented.len() >= state.next_reparented_sweep_at.max(Self::PRUNE_THRESHOLD) {
			state
				.reparented
				.retain(|entry| entry.process.status() == ProcessStatus::Running);
			state.next_reparented_sweep_at = state.reparented.len() + Self::PRUNE_THRESHOLD;
		}
	}

	/// Record a launch whose real process was never reported — a reparented
	/// launch whose report did not arrive, or one that fired no spawn hook —
	/// so [`SpawnRegistry::survivors`] reports itself incomplete.
	pub fn record_unreported(&self) {
		self.state.lock().unreported = true;
	}

	/// Processes recorded so far that are still alive — the identity pinned at
	/// spawn time still matches, so a recycled pid is never reported; zombies
	/// are not alive. Owned children come first in spawn order, then
	/// reparented launches, then unpinned launches whose pid is still in use,
	/// then leftover members of process groups owned spawns created.
	#[must_use]
	pub fn survivors(&self) -> Survivors {
		let (spawned, reparented, unpinned, groups, unreported) = {
			let state = self.state.lock();
			(
				state.spawned.clone(),
				state.reparented.clone(),
				state.unpinned.clone(),
				state.groups.clone(),
				state.unreported,
			)
		};
		let mut complete = !unreported;
		let owned = spawned.iter().filter_map(|entry| {
			let process = entry.process.as_ref()?;
			(process.status() == ProcessStatus::Running)
				.then(|| pinned_survivor(process, process.group_id().or(entry.pgid), false))
		});
		let reparented = reparented
			.iter()
			.filter(|entry| entry.process.status() == ProcessStatus::Running)
			.map(|entry| SpawnedProcess {
				reparented: true,
				..pinned_survivor(&entry.process, entry.pgid, false)
			});
		let mut processes: Vec<SpawnedProcess> = owned.chain(reparented).collect();
		for entry in unpinned {
			if !is_gone(entry.pid) {
				complete = false;
				processes.push(unpinned_survivor(entry.pid, entry.pgid, entry.reparented, false));
			}
		}

		if !push_group_members(groups, &mut processes) {
			complete = false;
		}
		Survivors { processes, complete }
	}

	/// Build the kill set from the processes recorded so far. Re-read on every
	/// signal wave so a child spawned during a grace window — between the
	/// cancel firing and the next wave — is still reaped.
	///
	/// A recorded process contributes only while alive; a recorded pgid
	/// contributes only while the group still has members, so once the run's
	/// whole tree exits the targets are empty and the wave loop can stop early.
	///
	/// Pruning also runs here so a cancellation cycle sees a compact target
	/// set even when the record-time threshold hasn't fired yet.
	#[must_use]
	pub fn build_targets(&self) -> TerminationTargets {
		let mut targets = TerminationTargets::new();
		let spawned = {
			let mut state = self.state.lock();
			prune_exited(&mut state.spawned);
			// Reset the watermark to the current live-set size + threshold;
			// leaving a stale pre-sweep value would misgate the next
			// record-time sweep.
			state.next_sweep_at = state.spawned.len() + Self::PRUNE_THRESHOLD;
			state.spawned.clone()
		};
		for entry in spawned {
			if let Some(process) = entry.process {
				targets.add_process(process);
			}
			// If the observer failed to pin a handle at spawn time (the child
			// exited before `Process::from_pid` could open it), the child is
			// already gone — signalling anything for that pid would either
			// no-op or, worse, race a recycled pid onto an unrelated process.
			// Drop the entry entirely rather than reintroduce the pid-reuse
			// window this whole change exists to close (#4605).
			if let Some(pgid) = entry.pgid
				&& pgid > 0
				&& process_group_alive(pgid)
			{
				targets.add_pgid(pgid);
			}
		}
		targets
	}
}

/// Drop registry entries whose pinned process, process group, and — on
/// Windows — descendant tree are all gone. With nothing still-live the entry
/// contributes nothing to the next termination wave and only pins an owned OS
/// handle for no reason.
///
/// The platform split matters because Windows has no process groups. On Unix
/// a child reparented onto init keeps its pgid, so a live pgid still catches
/// grandchildren whose immediate parent exited. On Windows there is no
/// reparenting and no pgid, so we probe the descendant tree directly through
/// the still-open pinned handle — dropping that handle would release the pid
/// slot, letting a recycled pid make future Toolhelp walks unsafe (issue
/// #4605) and orphaning any leftover child from the next cancellation wave.
fn prune_exited(spawned: &mut Vec<OwnedSpawn>) {
	spawned.retain(|entry| {
		if let Some(process) = &entry.process {
			if process.status() == ProcessStatus::Running {
				return true;
			}
			// Windows-only: root exited but the pinned handle still keeps its
			// pid reserved, so `live_descendants` walks the *original* subtree
			// via Toolhelp. If any child is still running we must keep the
			// entry — closing the handle would both release the pid (racing
			// pid reuse) and strand the surviving child.
			#[cfg(target_os = "windows")]
			if !process.live_descendants().is_empty() {
				return true;
			}
		}
		entry
			.pgid
			.is_some_and(|pgid| pgid > 0 && process_group_alive(pgid))
	});
}

/// True when process group `pgid` still has at least one member. `kill(2)`
/// with signal 0 performs permission/existence checks without delivering a
/// signal; `EPERM` means the group exists but is not ours to signal, which
/// still counts as alive.
#[must_use]
#[allow(
	clippy::missing_const_for_fn,
	reason = "calls non-const platform_process_group_alive on unix"
)]
fn process_group_alive(pgid: i32) -> bool {
	if pgid <= 0 {
		return false;
	}
	platform_process_group_alive(pgid)
}

#[cfg(unix)]
fn platform_process_group_alive(pgid: i32) -> bool {
	// SAFETY: `kill` takes integer identifiers by value and does not access
	// caller-owned memory. A negative pid targets the process group; signal 0
	// only runs the existence/permission checks.
	let ret = unsafe { libc::kill(-pgid, 0) };
	ret == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
const fn platform_process_group_alive(_pgid: i32) -> bool {
	false
}

/// True when `pid` provably names no live process (absent or a zombie).
fn is_gone(pid: i32) -> bool {
	process_identity(pid).state == IdentityState::Gone
}

/// The process group `pid` created at spawn — `pid` itself when the child
/// leads its own group — or `None` when it joined an existing one (including
/// the host's). The child is still unreaped when the spawn hook runs, so its
/// pid cannot have been recycled yet; the group is read zombie-aware because
/// a short-lived child (`sh -c 'cmd &'`) may already have exited.
#[cfg(unix)]
fn created_group(pid: i32, pgid: Option<i32>) -> Option<i32> {
	if pid <= 0 || is_self_process_group(pid) {
		return None;
	}
	if pgid == Some(pid) || platform::process_group_of(pid) == Some(pid) {
		Some(pid)
	} else {
		None
	}
}

#[cfg(not(unix))]
const fn created_group(_pid: i32, _pgid: Option<i32>) -> Option<i32> {
	None
}

fn pinned_survivor(process: &Process, pgid: Option<i32>, group_member: bool) -> SpawnedProcess {
	SpawnedProcess {
		pid: process.pid(),
		pgid,
		start_time: process.start_time_unix_secs(),
		start_id: Some(process.start_id()),
		reparented: false,
		group_member,
	}
}

const fn unpinned_survivor(
	pid: i32,
	pgid: Option<i32>,
	reparented: bool,
	group_member: bool,
) -> SpawnedProcess {
	SpawnedProcess { pid, pgid, start_time: None, start_id: None, reparented, group_member }
}

/// Append the live members (any user) of the still-populated `groups` that
/// `processes` does not already name, flagged `group_member`. Returns false
/// when the listing failed or may be missing a member (a live process whose
/// group could not be read, a hidden process table, a live group with no
/// process listed in it), or a member could not be identity-pinned; such a
/// member is still reported, without identity.
fn push_group_members(groups: HashSet<i32>, processes: &mut Vec<SpawnedProcess>) -> bool {
	let groups: HashSet<i32> = groups
		.into_iter()
		.filter(|group| !is_self_process_group(*group) && process_group_alive(*group))
		.collect();
	if groups.is_empty() {
		return true;
	}
	let Some(listing) = platform::list_group_members(&groups) else {
		return false;
	};
	let mut complete = !listing.partial
		&& groups
			.iter()
			.all(|group| listing.seen.contains(group) || !process_group_alive(*group));
	let mut listed: HashSet<i32> = processes.iter().map(|entry| entry.pid).collect();
	for (pid, group) in listing.members {
		if !listed.insert(pid) {
			continue;
		}
		match Process::from_pid(pid) {
			// Re-check membership on the pinned reference: the pid may have been
			// recycled since the listing.
			Some(process) => {
				if process.status() == ProcessStatus::Running && process.group_id() == Some(group) {
					processes.push(pinned_survivor(&process, Some(group), true));
				}
			},
			None if !is_gone(pid) => {
				complete = false;
				processes.push(unpinned_survivor(pid, Some(group), false, true));
			},
			None => {},
		}
	}
	complete
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn macos_pid_buffer_size_preserves_count_and_checks_byte_capacity() {
		let count = 4097;
		let (capacity, bytes) = macos_pid_buffer_size(count).expect("valid PID count");
		assert!(capacity > usize::try_from(count).unwrap(), "leave room for new processes");
		assert_eq!(usize::try_from(bytes).unwrap(), capacity * size_of::<i32>());
		assert_eq!(macos_pid_buffer_size(i32::MAX), None, "byte size must fit the C ABI");
		assert_eq!(macos_pid_buffer_size(0), None);
		assert_eq!(macos_pid_buffer_size(-1), None);
	}

	/// A reparented launch is reported as a survivor but never enters the kill
	/// set, and drops out of the report once it exits.
	#[cfg(unix)]
	#[test]
	fn reparented_spawns_are_reported_but_never_targeted() {
		use std::{os::unix::process::CommandExt as _, process::Command};

		let mut child = Command::new("sleep")
			.arg("30")
			.process_group(0)
			.spawn()
			.expect("spawn sleep");
		let pid = i32::try_from(child.id()).expect("child pid fits in i32");
		let registry = SpawnRegistry::new();
		registry.record_reparented(pid, Some(pid), Process::from_pid(pid));

		let targets_empty = registry.build_targets().is_empty();
		let survivors = registry.survivors();
		let fresh_start = process_identity(pid).start_time;
		let fresh_id = process_identity(pid).start_id;
		let _ = child.kill();
		let _ = child.wait();
		let after_exit = registry.survivors();

		assert!(targets_empty, "a reparented launch must never be signalled by teardown");
		assert!(fresh_start.is_some() && fresh_id.is_some());
		assert_eq!(survivors, Survivors {
			processes: vec![SpawnedProcess {
				pid,
				pgid: Some(pid),
				start_time: fresh_start,
				start_id: fresh_id,
				reparented: true,
				group_member: false,
			}],
			complete:  true,
		});
		assert!(
			after_exit.processes.is_empty() && after_exit.complete,
			"an exited launch must not be reported: {after_exit:?}"
		);
	}

	/// The harness pid must be the only protected pid. Including its recorded
	/// parent would be unsafe on Windows: that stale numeric pid can have been
	/// recycled onto the timed-out command, causing cancellation to spare the
	/// hung target and its whole subtree.
	#[test]
	fn host_protected_pids_includes_self() {
		let self_pid = i32::try_from(std::process::id()).expect("self pid fits in i32");
		assert_eq!(
			host_protected_pids(),
			HashSet::from([self_pid]),
			"only the harness pid may be protected from cancellation sweeps",
		);
	}

	/// Regression test for #7452: a cancellation sweep must never signal the
	/// protected host pid, even when it is enumerated as the sweep root. On
	/// Windows a recycled pid can make the harness surface as
	/// a false descendant of a just-spawned child; `TerminateProcess`-ing it
	/// killed the whole session with no `session_exit` record. The observable
	/// defense — provable cross-platform — is that `signal_tree_excluding`
	/// leaves a protected pid untouched.
	#[cfg(unix)]
	#[test]
	fn signal_tree_spares_protected_pids() {
		use std::{process::Command, thread, time::Duration};

		let mut child = Command::new("sleep")
			.arg("30")
			.spawn()
			.expect("spawn sleep");
		let child_pid = i32::try_from(child.id()).expect("child pid fits in i32");
		let root = Process::from_pid(child_pid).expect("pin child");

		// Treat the child's pid as protected (standing in for the harness/an
		// ancestor). The sweep must refuse to signal it.
		let protected: HashSet<i32> = HashSet::from([child_pid]);
		let signaled = root.signal_tree_excluding(KILL_SIGNAL, &protected);
		assert_eq!(signaled, 0, "a protected root must never be signalled");

		// The protected process is still alive after the sweep.
		thread::sleep(Duration::from_millis(50));
		assert_eq!(
			root.status(),
			ProcessStatus::Running,
			"a protected pid must survive a cancellation sweep",
		);

		// With no protection the same sweep reaps it — proves the skip is what
		// spared it, not a dead target.
		let reaped = root.signal_tree_excluding(KILL_SIGNAL, &HashSet::new());
		assert!(reaped >= 1, "an unprotected root must be signalled");
		let _ = child.wait();
	}

	/// Regression test for the #7453 review: pruning a protected node must drop
	/// its whole subtree, not just the exact protected pid. A Windows PID-reuse
	/// false-descendant collects the harness together with the harness's real
	/// children (LSP servers, worker/tool subprocesses); skipping only the host
	/// pid would still terminate those. `pid_in_protected_subtree` walks the
	/// enumerated parent map so any node under a protected pid is excluded.
	#[test]
	fn protected_subtree_is_pruned_not_just_the_pid() {
		// root(1) -> host(2, protected) -> worker(3); root(1) -> real_child(4).
		let parents: HashMap<i32, i32> = HashMap::from([(2, 1), (3, 2), (4, 1)]);
		let protected: HashSet<i32> = HashSet::from([2]);

		assert!(
			pid_in_protected_subtree(2, &protected, &parents),
			"the protected node itself must be excluded",
		);
		assert!(
			pid_in_protected_subtree(3, &protected, &parents),
			"a child collected through the protected node must be excluded too",
		);
		assert!(
			!pid_in_protected_subtree(4, &protected, &parents),
			"a real child of the sweep root must still be signalled",
		);
		assert!(
			!pid_in_protected_subtree(1, &protected, &parents),
			"the sweep root must not be pruned",
		);
	}

	/// `kill_process_group` is the last line of defense: even if a future
	/// caller manages to feed the harness's own pgid into the signal path,
	/// this wrapper must refuse to deliver the signal.
	#[cfg(unix)]
	#[test]
	fn kill_process_group_refuses_self_pgroup() {
		// SAFETY: `getpgid(0)` queries the calling process and does not touch
		// caller-owned memory.
		let self_pgid = unsafe { libc::getpgid(0) };
		assert!(self_pgid > 0, "getpgid(0) failed");
		assert!(
			!kill_process_group(self_pgid, TERM_SIGNAL),
			"kill_process_group must refuse the harness pgid; otherwise the test process would have \
			 been SIGTERMed",
		);
		assert!(
			!kill_process_group(0, TERM_SIGNAL),
			"kill_process_group must reject non-positive pgids",
		);
	}

	/// Regression test for the macOS `proc_listchildpids` brokenness: on
	/// darwin 25.4+ the kernel returns no entries when a process queries its
	/// own children via that API, so `Process::descendants` produced an empty
	/// list and termination cleanup silently became a no-op. The replacement
	/// path scans `proc_listallpids` and groups by `pbi_ppid`, which actually
	/// works. Linux has always worked via `/proc`.
	#[cfg(unix)]
	#[test]
	fn descendants_includes_freshly_spawned_child() {
		use std::{process::Command, thread, time::Duration};

		let mut child = Command::new("sleep")
			.arg("10")
			.spawn()
			.expect("spawn sleep");
		let child_pid = i32::try_from(child.id()).expect("child pid fits in i32");

		let self_pid = i32::try_from(std::process::id()).expect("self pid fits in i32");
		let harness = Process::from_pid(self_pid).expect("harness Process ref");

		// Allow a few polling iterations so the kernel's process-table query
		// settles on a loaded host. proc_listallpids reflects newly forked pids
		// within milliseconds in practice; 1s is a comfortable upper bound.
		let mut found = false;
		for _ in 0..40 {
			if harness
				.live_descendants()
				.iter()
				.any(|descendant| descendant.pid() == child_pid)
			{
				found = true;
				break;
			}
			thread::sleep(Duration::from_millis(25));
		}

		let _ = child.kill();
		let _ = child.wait();

		assert!(
			found,
			"freshly spawned child pid {child_pid} must appear in `live_descendants` so the \
			 cancellation cleanup can reach it; this regressed on macOS when the walk relied on the \
			 broken `proc_listchildpids`",
		);
	}

	/// Regression test for issue #4605: `SpawnRegistry` MUST pin a stable
	/// [`Process`] reference at spawn time rather than defer re-opening the
	/// pid until termination.
	///
	/// Before the fix, `SpawnRegistry` stored only the raw pid; `build_targets`
	/// called `Process::from_pid` at cancellation time. On Windows pids recycle
	/// aggressively, so a bash-spawned `pwsh.exe` that had already exited could
	/// see its pid reassigned to an unrelated PowerShell session (e.g. the
	/// user's other Cursor terminal). `Process::from_pid` at cancel time would
	/// happily open that unrelated process, and `signal_tree` would then
	/// enumerate — and `TerminateProcess` — the entire foreign subtree.
	///
	/// This test cannot literally trigger Windows pid recycling from a
	/// cross-platform Rust test, but it can prove the observable defense: a
	/// recorded process reference survives the original pid's death (so no
	/// "look it up again" step exists to be raced), and the registry never
	/// consults `Process::from_pid` when a handle was pinned at record time.
	#[cfg(unix)]
	#[test]
	fn spawn_registry_pins_identity_at_record_time() {
		use std::{process::Command, thread, time::Duration};

		// Phase 1: while the child is alive, the pinned handle carries identity
		// forward into `build_targets` without any `Process::from_pid` re-open
		// step existing to be raced against pid reuse.
		let mut long = Command::new("sleep")
			.arg("30")
			.spawn()
			.expect("spawn sleep");
		let long_pid = i32::try_from(long.id()).expect("child pid fits in i32");

		let registry = SpawnRegistry::new();
		let pinned = Process::from_pid(long_pid).expect("pin child at record time");
		registry.record(long_pid, None, Some(pinned));

		let live_targets = registry.build_targets();
		assert!(
			!live_targets.is_empty(),
			"a still-live pinned child must appear in the target set — otherwise the cancellation \
			 cleanup would silently miss it"
		);
		let live_pids: Vec<i32> = live_targets.processes.iter().map(Process::pid).collect();
		assert_eq!(
			live_pids,
			vec![long_pid],
			"target set must come from the pinned handle recorded at spawn time, not a re-lookup by \
			 pid (which would race pid reuse — issue #4605)"
		);

		let _ = long.kill();
		let _ = long.wait();

		// Phase 2: once the child exits, the registry MUST drop the entry
		// rather than reintroduce a `Process::from_pid` re-open at kill time.
		// Poll until pruning sees the pidfd as Exited (kernel-visible within
		// milliseconds in practice).
		let mut empty_after_exit = false;
		for _ in 0..40 {
			if registry.build_targets().is_empty() {
				empty_after_exit = true;
				break;
			}
			thread::sleep(Duration::from_millis(25));
		}
		assert!(
			empty_after_exit,
			"once the pinned child exits the registry must drop it — re-opening by pid at \
			 termination time is exactly the pid-reuse race #4605 closes"
		);
	}

	/// `TerminationTargets::add_process` must accept a pre-pinned handle
	/// without going through `Process::from_pid`. This is the API contract
	/// `SpawnRegistry` relies on to avoid the PID-reuse race.
	#[cfg(unix)]
	#[test]
	fn add_process_bypasses_from_pid_lookup() {
		let self_pid = i32::try_from(std::process::id()).expect("self pid fits in i32");
		let pinned = Process::from_pid(self_pid).expect("pin self");

		let mut targets = TerminationTargets::new();
		targets.add_process(pinned.clone());
		assert!(!targets.is_empty(), "add_process must record the pinned handle");

		// Adding the same pid again through either entry point must dedupe:
		// otherwise every wave in `terminate_run` would re-signal the same
		// tree N times.
		targets.add_process(pinned);
		targets.add_pid(self_pid);
		assert_eq!(targets.processes.len(), 1, "duplicate pids must be deduped");
	}

	/// Regression test for the review on PR #4606: a long-running shell
	/// command that spawns many short-lived external processes must not
	/// retain one owned handle per historical spawn — that would exhaust
	/// per-process FD/handle limits (pidfd on Linux, `HANDLE` on Windows).
	/// The registry MUST prune dead entries once the recorded vec crosses
	/// the sweep threshold.
	#[cfg(unix)]
	#[test]
	fn spawn_registry_prunes_exited_entries() {
		use std::{thread, time::Duration};

		let registry = SpawnRegistry::new();

		// Fabricate many recorded-then-exited children by pinning ourselves,
		// pushing the entry, then immediately treating it as "dead" from the
		// registry's perspective. To simulate the exit without actually
		// killing the harness, use `Process::from_pid(1)` for a pid that
		// (on Linux) is init and never exits — but wrap the recording in a
		// pattern that guarantees `status()` returns Exited for the pruner:
		// spawn a tiny child, pin it, wait for exit, then record.
		for _ in 0..(SpawnRegistry::PRUNE_THRESHOLD * 2) {
			let mut child = std::process::Command::new("true")
				.spawn()
				.expect("spawn true");
			let pid = i32::try_from(child.id()).expect("child pid fits in i32");
			let pinned = Process::from_pid(pid);
			let _ = child.wait();
			// Give the kernel a moment to mark the pidfd readable so `status()`
			// reports Exited when the pruner probes.
			for _ in 0..20 {
				if pinned
					.as_ref()
					.is_some_and(|process| process.status() == ProcessStatus::Exited)
				{
					break;
				}
				thread::sleep(Duration::from_millis(5));
			}
			registry.record(pid, None, pinned);
		}

		let retained = registry.state.lock().spawned.len();
		assert!(
			retained < SpawnRegistry::PRUNE_THRESHOLD,
			"pruning must bound retained entries below the sweep threshold once the pinned processes \
			 have exited; got {retained} retained (threshold {})",
			SpawnRegistry::PRUNE_THRESHOLD
		);

		// build_targets sees no live handles → empty target set, matching the
		// contract that fully-exited registries stop the wave loop early.
		let targets = registry.build_targets();
		assert!(targets.is_empty(), "registry of only-dead entries must produce an empty target set");
	}

	/// Regression test for the third review on PR #4606: once the recorded
	/// vec crosses `PRUNE_THRESHOLD`, subsequent `record` calls must NOT
	/// sweep on every spawn. Without the `next_sweep_at` watermark, a large
	/// fan-out run whose live children exceed the threshold turned every
	/// spawn into an O(N) status probe of the whole retained set.
	///
	/// The check reasons about the observable side effect: after N records
	/// past threshold with entries that CANNOT be pruned (all still live),
	/// the retained size grows monotonically by exactly N — no sweep runs
	/// have modified the vec in between. The direct signal of "did a sweep
	/// happen" is a stable pinned handle count across records.
	#[cfg(unix)]
	#[test]
	fn spawn_registry_watermark_bounds_sweep_frequency() {
		let self_pid = i32::try_from(std::process::id()).expect("self pid fits in i32");
		let registry = SpawnRegistry::new();

		// Fill past threshold with entries that are permanently alive
		// (pinning ourselves) so the pruner has nothing to remove.
		let fill = SpawnRegistry::PRUNE_THRESHOLD + 10;
		for _ in 0..fill {
			registry.record(self_pid, None, Process::from_pid(self_pid));
		}
		let after_fill = registry.state.lock().spawned.len();
		assert_eq!(after_fill, fill, "live-only entries must not be pruned during warm-up");
		let watermark_after_fill = registry.state.lock().next_sweep_at;

		// Every additional record with a live entry must land in the vec
		// verbatim and — critically — NOT re-enter `prune_exited` until the
		// vec crosses the freshly scheduled watermark. If the guard were
		// still `len >= PRUNE_THRESHOLD` (pre-fix), a sweep would fire on
		// every one of these records.
		let extra = 20;
		for _ in 0..extra {
			registry.record(self_pid, None, Process::from_pid(self_pid));
		}
		let after_extra = registry.state.lock().spawned.len();
		assert_eq!(
			after_extra,
			after_fill + extra,
			"records with live entries must accumulate without triggering per-spawn sweeps"
		);
		assert_eq!(
			registry.state.lock().next_sweep_at,
			watermark_after_fill,
			"watermark must not advance while the vec stays below it — otherwise a sweep ran"
		);
	}

	#[test]
	fn env_marker_token_matches_whole_elements_of_the_first_named_entry() {
		let env = |entries: &'static [&'static str]| entries.iter().map(|entry| entry.as_bytes());
		let has = |entries, token| env_marker_token(env(entries), "OMP_OWNER", &[token]).is_some();

		assert!(has(&["OMP_OWNER=a,omp1:1:2"], "omp1:1:2"));
		assert!(has(&["OMP_OWNER=omp1:1:2,b"], "omp1:1:2"));
		assert!(!has(&["OMP_OWNER=omp1:1:22"], "omp1:1:2"), "no prefix match");
		assert!(!has(&["OMP_OWNER=xomp1:1:2"], "omp1:1:2"), "no suffix match");
		assert!(
			!has(&["OMP_OWNERX=omp1:1:2", "X_OMP_OWNER=omp1:1:2"], "omp1:1:2"),
			"exact name only"
		);
		assert!(!has(&["OMP_OWNER"], "omp1:1:2"));
		// getenv returns the first entry; later duplicates are shadowed.
		assert!(!has(&["OMP_OWNER=other", "OMP_OWNER=omp1:1:2"], "omp1:1:2"));
	}

	#[cfg(unix)]
	mod marker_scan {
		use std::{
			os::unix::process::CommandExt as _,
			process::{Child, Command, Stdio},
			time::{Duration, Instant},
		};

		use super::super::{
			MarkedProcess, MarkedProcessScan, process_identity, scan_processes_by_env,
		};

		const SLEEPER_TEST: &str = "process::tests::marker_scan::marker_scan_sleeper";
		const SLEEPER_ENV: &str = "PI_SHELL_MARKER_SCAN_SLEEPER";

		/// Long-lived marked process for the scan tests. It re-executes this test
		/// binary — a non-platform executable — because macOS withholds the
		/// environment of Apple platform binaries such as `/bin/sleep`. With
		/// `SLEEPER_ENV=nondumpable` it first makes itself non-dumpable, which
		/// on Linux denies other non-root processes its environment.
		#[test]
		#[ignore = "helper process for the marker scan tests"]
		fn marker_scan_sleeper() {
			let Some(mode) = std::env::var_os(SLEEPER_ENV) else {
				return;
			};
			#[cfg(target_os = "linux")]
			if mode == "nondumpable" {
				// SAFETY: `prctl(PR_SET_DUMPABLE, 0)` takes scalars only.
				assert_eq!(unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) }, 0);
				// Straight to fd 1: libtest captures `print!` output.
				let ready = b"\nnondumpable\n";
				// SAFETY: `ready` is valid for its length.
				unsafe { libc::write(1, ready.as_ptr().cast(), ready.len()) };
			}
			let _ = mode;
			std::thread::sleep(Duration::from_secs(30));
		}

		fn sleeper_args() -> [&'static str; 4] {
			["--exact", SLEEPER_TEST, "--ignored", "--test-threads=1"]
		}

		fn sleeper(owner: Option<&str>) -> Command {
			let mut command = Command::new(std::env::current_exe().expect("test binary path"));
			command
				.args(sleeper_args())
				.env(SLEEPER_ENV, "1")
				.env_remove("OMP_OWNER")
				.stdin(Stdio::null())
				.stdout(Stdio::null())
				.stderr(Stdio::null());
			if let Some(owner) = owner {
				command.env("OMP_OWNER", owner);
			}
			command
		}

		/// Kills every tracked pid on drop, so a failed assertion leaks nothing.
		#[derive(Default)]
		struct Reaper {
			children: Vec<Child>,
			pids:     Vec<i32>,
		}

		impl Drop for Reaper {
			fn drop(&mut self) {
				for child in &mut self.children {
					let _ = child.kill();
					let _ = child.wait();
				}
				for pid in &self.pids {
					// SAFETY: `kill` takes scalars and touches no caller memory.
					unsafe { libc::kill(*pid, libc::SIGKILL) };
				}
			}
		}

		fn token(tag: &str) -> String {
			format!("omp1:{}:{tag}", std::process::id())
		}

		fn find(token: &str, pid: i32) -> Option<MarkedProcess> {
			let scan = scan_processes_by_env("OMP_OWNER", &[token], None);
			assert!(scan.supported);
			scan.processes.into_iter().find(|entry| entry.pid == pid)
		}

		fn child_pid(child: &Child) -> i32 {
			i32::try_from(child.id()).expect("pid fits in i32")
		}

		#[test]
		fn finds_marked_child_with_its_identity() {
			let token = token("child");
			let mut reaper = Reaper::default();
			let child = sleeper(Some(&format!("a,{token}")))
				.spawn()
				.expect("spawn sleeper");
			let pid = child_pid(&child);
			reaper.children.push(child);

			let entry = find(&token, pid).expect("marked child is found");
			let self_pid = i32::try_from(std::process::id()).expect("pid fits in i32");
			assert_eq!(entry.ppid, self_pid);
			assert!(entry.start_time.is_some());
			assert_eq!(entry.start_time, process_identity(pid).start_time);
			assert!(entry.start_id.is_some());
			assert_eq!(entry.start_id, process_identity(pid).start_id);
			// SAFETY: `getpgid` takes a scalar and touches no caller memory.
			assert_eq!(entry.pgid, Some(unsafe { libc::getpgid(pid) }));
			assert!(!entry.command.is_empty());
			assert_eq!(entry.token.as_deref(), Some(token.as_str()));
			#[cfg(target_os = "linux")]
			assert_eq!(entry.start_id, Some(stat_field_22(pid)), "startId is raw stat field 22");
		}

		/// `/proc/<pid>/stat` field 22 (start ticks), parsed independently of
		/// the code under test: the fields after the last `)` start at field 3.
		#[cfg(target_os = "linux")]
		fn stat_field_22(pid: i32) -> u64 {
			let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).expect("read stat");
			let (_, fields) = stat.rsplit_once(')').expect("stat has a comm field");
			fields
				.split_whitespace()
				.nth(22 - 3)
				.expect("field 22")
				.parse()
				.expect("numeric start ticks")
		}

		/// Each match names the first requested token it carries, in request
		/// order; no tokens match nothing.
		#[test]
		fn reports_the_first_requested_token_carried() {
			let (first, second, absent) = (token("first"), token("second"), token("absent"));
			let mut reaper = Reaper::default();
			let child = sleeper(Some(&format!("{second},{first}")))
				.spawn()
				.expect("spawn sleeper");
			let pid = child_pid(&child);
			reaper.children.push(child);

			let token_of = |tokens: &[&str]| {
				let scan = scan_processes_by_env("OMP_OWNER", tokens, None);
				assert!(scan.scanned > 0);
				scan
					.processes
					.into_iter()
					.find(|entry| entry.pid == pid)
					.map(|entry| entry.token)
			};
			assert_eq!(token_of(&[&absent, &first, &second]), Some(Some(first.clone())));
			assert_eq!(token_of(&[&second, &first]), Some(Some(second.clone())));
			assert_eq!(token_of(&[&absent]), None);
			assert_eq!(token_of(&[]), None);
		}

		#[test]
		fn token_match_is_exact_per_element() {
			let mut reaper = Reaper::default();
			let child = sleeper(Some(&format!("x,{},y", token("22"))))
				.spawn()
				.expect("spawn sleeper");
			let pid = child_pid(&child);
			reaper.children.push(child);

			assert!(find(&token("2"), pid).is_none(), "`…:2` must not match `…:22`");
			assert!(find(&token("22"), pid).is_some());
		}

		#[test]
		fn ignores_token_outside_the_named_variable() {
			let token = token("unmarked");
			let mut reaper = Reaper::default();
			let child = sleeper(None)
				// The token in argv and in look-alike variables only.
				.arg(format!("OMP_OWNER={token}"))
				.env("OMP_OWNERX", &token)
				.env("X_OMP_OWNER", &token)
				.spawn()
				.expect("spawn sleeper");
			let pid = child_pid(&child);
			reaper.children.push(child);

			assert!(find(&token, pid).is_none());
		}

		#[test]
		fn excludes_the_caller() {
			// A variable this process was exec'd with; a child inheriting it
			// matches, the caller itself must not.
			let path = std::env::var("PATH").expect("PATH is set");
			assert!(!path.contains(','));
			let mut reaper = Reaper::default();
			let child = sleeper(None).spawn().expect("spawn sleeper");
			let pid = child_pid(&child);
			reaper.children.push(child);

			let scan = scan_processes_by_env("PATH", &[&path], None);
			let self_pid = i32::try_from(std::process::id()).expect("pid fits in i32");
			assert!(scan.processes.iter().any(|entry| entry.pid == pid));
			assert!(scan.processes.iter().all(|entry| entry.pid != self_pid));
		}

		#[test]
		fn finds_double_forked_daemon_by_marker() {
			let token = token("daemon");
			let mut reaper = Reaper::default();
			let exe = std::env::current_exe().expect("test binary path");
			// `sh` becomes a session leader, backgrounds the sleeper and exits:
			// the sleeper is orphaned into a new session and its pid is never
			// returned to us.
			let mut launcher = Command::new("/bin/sh");
			launcher
				.arg("-c")
				.arg(r#""$0" "$@" </dev/null >/dev/null 2>&1 & exit 0"#)
				.arg(&exe)
				.args(sleeper_args())
				.env(SLEEPER_ENV, "1")
				.env("OMP_OWNER", format!("{token},b"))
				.stdin(Stdio::null())
				.stdout(Stdio::null())
				.stderr(Stdio::null());
			// SAFETY: `setsid` is async-signal-safe and touches no caller memory.
			unsafe {
				launcher.pre_exec(|| {
					if libc::setsid() < 0 {
						return Err(std::io::Error::last_os_error());
					}
					Ok(())
				});
			}
			let mut launcher = launcher.spawn().expect("spawn launcher");
			let launcher_pid = child_pid(&launcher);
			assert!(launcher.wait().expect("launcher exits").success());

			let deadline = Instant::now() + Duration::from_secs(10);
			let daemon = loop {
				let scan = scan_processes_by_env("OMP_OWNER", &[&token], None);
				if let Some(entry) = scan.processes.into_iter().next() {
					break entry;
				}
				assert!(Instant::now() < deadline, "daemon never appeared in the scan");
				std::thread::sleep(Duration::from_millis(50));
			};
			reaper.pids.push(daemon.pid);

			assert_ne!(daemon.pid, launcher_pid);
			assert_ne!(daemon.ppid, launcher_pid, "the daemon was reparented");
			// SAFETY: `getsid` takes a scalar and touches no caller memory.
			let daemon_sid = unsafe { libc::getsid(daemon.pid) };
			assert_eq!(daemon_sid, launcher_pid, "the daemon left our session");
			assert_eq!(daemon.start_time, process_identity(daemon.pid).start_time);
		}

		/// `opaque_since` is a start id: an unexaminable process is listed when
		/// its start id is at or after it, or unknown, and never without one.
		#[test]
		fn opaque_selection_compares_start_ids() {
			let entry = |pid, start_id| MarkedProcess {
				pid,
				ppid: 1,
				pgid: None,
				start_time: Some(0),
				start_id,
				command: String::new(),
				token: None,
			};
			let mut scan = MarkedProcessScan::default();
			for since in [None, Some(100)] {
				scan.push_opaque(entry(1, Some(99)), since);
				scan.push_opaque(entry(2, Some(100)), since);
				scan.push_opaque(entry(3, Some(101)), since);
				scan.push_opaque(entry(4, None), since);
			}
			let listed: Vec<i32> = scan.opaque.iter().map(|entry| entry.pid).collect();
			assert_eq!(listed, [2, 3, 4]);
		}

		/// Empty arguments must not shift where the environment is read from
		/// (macOS `KERN_PROCARGS2` interleaves no marker): a marker spelled as an
		/// argument never matches, and one in the environment still does.
		#[test]
		fn empty_arguments_do_not_blur_argv_and_environment() {
			let token = token("argv");
			let marker_arg = format!("OMP_OWNER={token}");
			let mut reaper = Reaper::default();
			// The environment holds only the marker and the helper switch, with
			// the marker first: a parser that misplaces the argv/environment
			// boundary by one entry in either direction gets one of the two
			// processes wrong.
			let spawn = |owner: Option<&str>| {
				let mut command = sleeper(None);
				command.env_clear().env(SLEEPER_ENV, "1");
				if let Some(owner) = owner {
					command.env("OMP_OWNER", owner);
				}
				let child = command
					.arg0("")
					.arg("")
					.arg(&marker_arg)
					.spawn()
					.expect("spawn sleeper");
				(child_pid(&child), child)
			};
			let (unmarked, child) = spawn(None);
			reaper.children.push(child);
			let (marked, child) = spawn(Some(&token));
			reaper.children.push(child);

			let found: Vec<i32> = scan_processes_by_env("OMP_OWNER", &[&token], None)
				.processes
				.iter()
				.map(|entry| entry.pid)
				.collect();
			assert!(!found.contains(&unmarked), "an argv element matched as the marker");
			assert!(found.contains(&marked), "the marked environment was missed");
		}

		/// A process with an empty environment is counted as redacted and listed
		/// as opaque exactly while `opaque_since` is at or before its start.
		#[cfg(target_os = "linux")]
		#[test]
		fn empty_environment_is_redacted_and_opaque_from_its_start() {
			let token = token("redacted");
			let mut reaper = Reaper::default();
			let child = Command::new("/bin/sleep")
				.arg("7431")
				.env_clear()
				.stdin(Stdio::null())
				.stdout(Stdio::null())
				.stderr(Stdio::null())
				.spawn()
				.expect("spawn sleep");
			let pid = child_pid(&child);
			reaper.children.push(child);
			let start = stat_field_22(pid);

			let scan = scan_processes_by_env("OMP_OWNER", &[&token], Some(start));
			assert!(scan.redacted > 0);
			let entry = scan
				.opaque
				.iter()
				.find(|entry| entry.pid == pid)
				.expect("the empty-environment process is opaque");
			assert_eq!(entry.start_id, Some(start));
			assert_eq!(entry.token, None);
			let later = scan_processes_by_env("OMP_OWNER", &[&token], Some(start + 1));
			assert!(later.opaque.iter().all(|entry| entry.pid != pid));
		}

		/// A live process whose environment this user cannot read (non-dumpable)
		/// is counted unreadable and listed as opaque, never dropped.
		#[cfg(target_os = "linux")]
		#[test]
		fn unreadable_environment_is_counted_and_opaque() {
			use std::io::BufRead as _;

			let token = token("nondumpable");
			let mut reaper = Reaper::default();
			let mut child = sleeper(Some(&token))
				.env(SLEEPER_ENV, "nondumpable")
				.stdout(Stdio::piped())
				.spawn()
				.expect("spawn sleeper");
			let pid = child_pid(&child);
			let stdout = child.stdout.take().expect("piped stdout");
			reaper.children.push(child);
			// The helper announces itself once it is non-dumpable (after
			// libtest's own header lines).
			let ready = std::io::BufReader::new(stdout)
				.lines()
				.map_while(Result::ok)
				.any(|line| line == "nondumpable");
			assert!(ready, "helper never became non-dumpable");

			let scan = scan_processes_by_env("OMP_OWNER", &[&token], Some(0));
			if std::fs::read(format!("/proc/{pid}/environ")).is_ok() {
				// Root with CAP_SYS_PTRACE reads it anyway: then it must match.
				assert!(scan.processes.iter().any(|entry| entry.pid == pid));
				return;
			}
			assert!(scan.unreadable > 0);
			assert!(scan.processes.iter().all(|entry| entry.pid != pid));
			let entry = scan
				.opaque
				.iter()
				.find(|entry| entry.pid == pid)
				.expect("the unreadable process is opaque");
			assert_eq!(entry.start_id, Some(stat_field_22(pid)));
		}
	}

	#[cfg(unix)]
	mod candidates {
		use super::super::uid_candidate;

		/// A setuid launch keeps our uid as its real or saved uid while its
		/// effective uid changes; it must still be scanned.
		#[test]
		fn a_process_is_ours_by_real_effective_or_saved_uid() {
			let ours = [1000, 1000];
			assert!(uid_candidate([1000, 0, 0], ours), "setuid-root launch: real uid is ours");
			assert!(uid_candidate([0, 0, 1000], ours), "saved uid is ours");
			assert!(uid_candidate([0, 1000, 0], ours), "effective uid is ours");
			assert!(!uid_candidate([0, 0, 0], ours));
			// Our own real uid counts even when we run setuid ourselves.
			assert!(uid_candidate([501, 501, 501], [501, 0]));
		}

		#[cfg(target_os = "linux")]
		#[test]
		fn status_uids_reads_real_effective_and_saved() {
			let status =
				"Name:\tsleep\nUmask:\t0022\nUid:\t1000\t0\t0\t0\nGid:\t1000\t1000\t1000\t1000\n";
			assert_eq!(super::super::platform::status_uids(status), Some([1000, 0, 0]));
			assert_eq!(super::super::platform::status_uids("Name:\tx\n"), None);
		}

		/// `hidden` follows the `hidepid` option of the last `proc` mount on
		/// `/proc`, in either option list.
		#[cfg(target_os = "linux")]
		#[test]
		fn mountinfo_hidepid_decides_hidden() {
			use super::super::platform::mountinfo_hides_processes as hides;

			let proc_mount = |mount_options: &str, super_options: &str| {
				format!("22 1 0:5 / /proc {mount_options} shared:12 - proc proc {super_options}\n")
			};
			let root = "20 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw\n";
			assert!(!hides(&format!("{root}{}", proc_mount("rw,nosuid", "rw"))));
			assert!(!hides(&proc_mount("rw", "rw,hidepid=0")));
			assert!(!hides(&proc_mount("rw", "rw,hidepid=off")));
			assert!(hides(&proc_mount("rw", "rw,hidepid=invisible")));
			assert!(hides(&proc_mount("rw", "rw,hidepid=2,gid=10")));
			assert!(hides(&proc_mount("rw,hidepid=ptraceable", "rw")));
			// Remounted: the later mount wins.
			assert!(hides(&format!("{}{}", proc_mount("rw", "rw"), proc_mount("rw", "rw,hidepid=1"))));
			// A `proc` mounted elsewhere says nothing about `/proc`.
			assert!(hides("30 1 0:9 / /mnt/proc rw - proc proc rw\n"));
		}
	}

	#[cfg(unix)]
	mod identity {
		use std::{
			process::{Child, Command, Stdio},
			time::{Duration, Instant},
		};

		use super::super::{
			IdentityState, Process, ProcessIdentity, SpawnRegistry, process_identity,
		};

		fn sleep_child(seconds: &str) -> (Child, i32) {
			let child = Command::new("/bin/sleep")
				.arg(seconds)
				.stdin(Stdio::null())
				.stdout(Stdio::null())
				.stderr(Stdio::null())
				.spawn()
				.expect("spawn sleep");
			let pid = i32::try_from(child.id()).expect("pid fits in i32");
			(child, pid)
		}

		fn wait_for_state(pid: i32, state: IdentityState) -> ProcessIdentity {
			let deadline = Instant::now() + Duration::from_secs(10);
			loop {
				let identity = process_identity(pid);
				if identity.state == state || Instant::now() >= deadline {
					return identity;
				}
				std::thread::sleep(Duration::from_millis(10));
			}
		}

		#[test]
		fn running_process_has_a_stable_start_id_distinct_from_others() {
			let self_pid = i32::try_from(std::process::id()).expect("pid fits in i32");
			let first = process_identity(self_pid);
			assert_eq!(first.state, IdentityState::Running);
			assert!(first.start_id.is_some() && first.start_time.is_some());
			assert_eq!(process_identity(self_pid), first, "two reads agree");

			let (mut child, pid) = sleep_child("7381");
			let child_identity = process_identity(pid);
			let pinned = Process::from_pid(pid).map(|process| process.start_id());
			let _ = child.kill();
			let _ = child.wait();

			assert_eq!(child_identity.state, IdentityState::Running);
			assert_ne!(child_identity.start_id, first.start_id, "a new process has a new start id");
			assert_eq!(pinned, child_identity.start_id, "a pinned reference reports the same id");
		}

		#[test]
		fn reaped_process_is_gone() {
			let (mut child, pid) = sleep_child("7382");
			let _ = child.kill();
			let _ = child.wait();
			let identity = process_identity(pid);
			assert_eq!(identity, ProcessIdentity {
				state:      IdentityState::Gone,
				start_id:   None,
				start_time: None,
			});
		}

		/// An exited but unreaped child (a zombie) still occupies its pid, yet it
		/// is gone for identity purposes.
		#[test]
		fn unreaped_zombie_is_gone() {
			let mut child = Command::new("/bin/sh")
				.arg("-c")
				.arg("exit 0")
				.stdin(Stdio::null())
				.spawn()
				.expect("spawn sh");
			let pid = i32::try_from(child.id()).expect("pid fits in i32");
			let identity = wait_for_state(pid, IdentityState::Gone);
			// SAFETY: `kill` with signal 0 only probes; the unreaped zombie keeps
			// the pid, so this cannot reach another process.
			let zombie_present = unsafe { libc::kill(pid, 0) } == 0;
			let _ = child.wait();

			assert!(zombie_present, "the child must still be an unreaped zombie");
			assert_eq!(identity.state, IdentityState::Gone);
			assert_eq!(identity.start_id, None);
		}

		/// pid 1 belongs to root: readable (Linux `/proc`) or not, it is never
		/// mistaken for gone.
		#[test]
		fn other_users_process_is_not_gone() {
			let identity = process_identity(1);
			assert_ne!(identity.state, IdentityState::Gone, "{identity:?}");
			assert_eq!(identity.start_id.is_some(), identity.state == IdentityState::Running);
		}

		#[test]
		fn unreported_launch_makes_survivors_incomplete() {
			let registry = SpawnRegistry::new();
			assert!(registry.survivors().complete);
			registry.record_unreported();
			let survivors = registry.survivors();
			assert!(!survivors.complete);
			assert!(survivors.processes.is_empty());
		}

		/// An owned spawn whose pin failed while it was alive is still reported —
		/// by pid, without a start identity — and marks the list incomplete until
		/// its pid is gone.
		#[test]
		fn unpinned_live_spawn_is_reported_without_identity() {
			let (mut child, pid) = sleep_child("7383");
			let registry = SpawnRegistry::new();
			registry.record(pid, None, None);
			let live = registry.survivors();
			let _ = child.kill();
			let _ = child.wait();
			let after_exit = registry.survivors();

			assert!(!live.complete);
			let [entry] = live.processes.as_slice() else {
				panic!("expected the unpinned child, got {live:?}");
			};
			assert_eq!(entry.pid, pid);
			assert_eq!((entry.start_id, entry.start_time), (None, None));
			assert!(!entry.reparented && !entry.group_member);
			assert!(after_exit.complete && after_exit.processes.is_empty(), "{after_exit:?}");
		}

		/// A process left in the group an owned spawn created is reported as a
		/// group member once the spawn itself has exited.
		#[test]
		fn leftover_member_of_owned_group_is_reported() {
			use std::os::unix::process::CommandExt as _;

			let registry = SpawnRegistry::new();
			let mut leader = Command::new("/bin/sleep")
				.arg("7384")
				.process_group(0)
				.stdin(Stdio::null())
				.spawn()
				.expect("spawn leader");
			let leader_pid = i32::try_from(leader.id()).expect("pid fits in i32");
			let mut member = Command::new("/bin/sleep")
				.arg("7385")
				.process_group(leader_pid)
				.stdin(Stdio::null())
				.spawn()
				.expect("spawn member");
			let member_pid = i32::try_from(member.id()).expect("pid fits in i32");
			registry.record(leader_pid, None, Process::from_pid(leader_pid));
			let _ = leader.kill();
			let _ = leader.wait();
			let survivors = registry.survivors();
			let member_identity = process_identity(member_pid);
			let _ = member.kill();
			let _ = member.wait();

			assert!(survivors.complete, "{survivors:?}");
			let [entry] = survivors.processes.as_slice() else {
				panic!("expected only the group member, got {survivors:?}");
			};
			assert_eq!(entry.pid, member_pid);
			assert_eq!(entry.pgid, Some(leader_pid));
			assert!(entry.group_member && !entry.reparented);
			assert_eq!(entry.start_id, member_identity.start_id);
		}

		/// A process a reparented launch leaves in its process group (`nohup sh
		/// -c 'cmd &' &`) is reported as a group member once the launch exits.
		#[test]
		fn leftover_member_of_reparented_launch_group_is_reported() {
			use std::os::unix::process::CommandExt as _;

			let registry = SpawnRegistry::new();
			let mut leader = Command::new("/bin/sleep")
				.arg("7386")
				.process_group(0)
				.stdin(Stdio::null())
				.spawn()
				.expect("spawn leader");
			let leader_pid = i32::try_from(leader.id()).expect("pid fits in i32");
			let mut member = Command::new("/bin/sleep")
				.arg("7387")
				.process_group(leader_pid)
				.stdin(Stdio::null())
				.spawn()
				.expect("spawn member");
			let member_pid = i32::try_from(member.id()).expect("pid fits in i32");
			registry.record_reparented(leader_pid, Some(leader_pid), Process::from_pid(leader_pid));
			let _ = leader.kill();
			let _ = leader.wait();
			let survivors = registry.survivors();
			let _ = member.kill();
			let _ = member.wait();

			assert!(survivors.complete, "{survivors:?}");
			let [entry] = survivors.processes.as_slice() else {
				panic!("expected only the group member, got {survivors:?}");
			};
			assert_eq!(entry.pid, member_pid);
			assert!(entry.group_member && !entry.reparented, "{entry:?}");
		}

		/// A member of an owned group running as another user is still
		/// reported. Only root can start one, so other runs return early.
		#[test]
		fn other_users_member_of_owned_group_is_reported() {
			use std::os::unix::process::CommandExt as _;

			// SAFETY: `geteuid` takes no arguments and cannot fail.
			if unsafe { libc::geteuid() } != 0 {
				return;
			}
			let registry = SpawnRegistry::new();
			let mut leader = Command::new("/bin/sleep")
				.arg("7388")
				.process_group(0)
				.stdin(Stdio::null())
				.spawn()
				.expect("spawn leader");
			let leader_pid = i32::try_from(leader.id()).expect("pid fits in i32");
			let mut member = Command::new("/bin/sleep")
				.arg("7389")
				.process_group(leader_pid)
				.uid(65534)
				.gid(65534)
				.stdin(Stdio::null())
				.spawn()
				.expect("spawn member as another user");
			let member_pid = i32::try_from(member.id()).expect("pid fits in i32");
			registry.record(leader_pid, None, Process::from_pid(leader_pid));
			let _ = leader.kill();
			let _ = leader.wait();
			let survivors = registry.survivors();
			let _ = member.kill();
			let _ = member.wait();

			assert!(
				survivors
					.processes
					.iter()
					.any(|entry| entry.pid == member_pid && entry.group_member),
				"{survivors:?}"
			);
			// Reported without identity only when it could not be pinned.
			assert!(survivors.complete || survivors.processes.iter().any(|e| e.start_id.is_none()));
		}

		/// A process whose leader thread exited (`pthread_exit`) while another
		/// thread runs shows a zombie leader, yet it is alive.
		#[cfg(target_os = "linux")]
		#[test]
		fn zombie_leader_with_a_live_thread_is_running() {
			extern "C" fn park(_: *mut libc::c_void) -> *mut libc::c_void {
				loop {
					// SAFETY: `pause` takes no arguments.
					unsafe { libc::pause() };
				}
			}

			// SAFETY: the child only starts one thread and ends its own leader
			// thread with the raw `exit` syscall; it is killed below.
			let pid = unsafe { libc::fork() };
			assert!(pid >= 0, "fork failed");
			if pid == 0 {
				// SAFETY: see above; `_exit` ends the child if the thread fails.
				unsafe {
					let mut thread: libc::pthread_t = std::mem::zeroed();
					if libc::pthread_create(
						&raw mut thread,
						std::ptr::null(),
						park,
						std::ptr::null_mut(),
					) != 0
					{
						libc::_exit(1);
					}
					libc::syscall(libc::SYS_exit, 0);
					libc::_exit(2);
				}
			}
			let leader_state = || {
				std::fs::read_to_string(format!("/proc/{pid}/stat"))
					.ok()
					.and_then(|stat| {
						stat
							.rsplit_once(')')?
							.1
							.split_whitespace()
							.next()?
							.chars()
							.next()
					})
			};
			let deadline = Instant::now() + Duration::from_secs(10);
			while leader_state() != Some('Z') && Instant::now() < deadline {
				std::thread::sleep(Duration::from_millis(10));
			}
			let zombie_leader = leader_state() == Some('Z');
			let identity = process_identity(pid);
			// SAFETY: signals and reaps exactly the child forked above.
			unsafe {
				libc::kill(pid, libc::SIGKILL);
				libc::waitpid(pid, std::ptr::null_mut(), 0);
			}

			assert!(zombie_leader, "the leader thread never exited");
			assert_eq!(identity.state, IdentityState::Running, "{identity:?}");
			assert!(identity.start_id.is_some());
		}
	}
}
