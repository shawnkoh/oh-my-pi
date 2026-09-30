//! Command execution utilities.

pub use std::os::unix::process::{CommandExt, ExitStatusExt};

use command_fds::{CommandFdExt, FdMapping};

use crate::{ShellFd, error, openfiles};

/// Extension trait for injecting file descriptors into commands.
pub trait CommandFdInjectionExt {
	/// Injects the given open files as file descriptors into the command.
	///
	/// # Arguments
	///
	/// * `open_files` - A mapping of child file descriptors to open files.
	fn inject_fds(
		&mut self,
		open_files: impl Iterator<Item = (ShellFd, openfiles::OpenFile)>,
	) -> Result<(), error::Error>;
}

impl CommandFdInjectionExt for std::process::Command {
	fn inject_fds(
		&mut self,
		open_files: impl Iterator<Item = (ShellFd, openfiles::OpenFile)>,
	) -> Result<(), error::Error> {
		let fd_mappings: Vec<FdMapping> = open_files
			.map(|(child_fd, open_file)| -> Result<FdMapping, error::Error> {
				let parent_fd = open_file.try_clone_to_owned()?;
				Ok(FdMapping { child_fd, parent_fd })
			})
			.collect::<Result<Vec<_>, _>>()?;

		self
			.fd_mappings(fd_mappings)
			.map_err(|_e| error::ErrorKind::ChildCreationFailure)?;

		Ok(())
	}
}

/// Extension trait for arranging for commands to take the foreground.
pub trait CommandFgControlExt {
	/// Arranges for the command to take the foreground when it is executed.
	fn take_foreground(&mut self);
	/// Arranges for the command to become a session leader when it is executed.
	fn lead_session(&mut self);
}

impl CommandFgControlExt for std::process::Command {
	fn take_foreground(&mut self) {
		// SAFETY:
		// This arranges for a provided function to run in the context of
		// the forked process before it exec's the target command. In general,
		// rust can't guarantee safety of code running in such a context.
		unsafe {
			self.pre_exec(pre_exec_take_foreground);
		}
	}

	fn lead_session(&mut self) {
		// SAFETY:
		// This arranges for a provided function to run in the context of
		// the forked process before it exec's the target command. In general,
		// rust can't guarantee safety of code running in such a context.
		unsafe {
			self.pre_exec(pre_exec_lead_session);
		}
	}
}

/// Extension trait for detaching commands from the parent's controlling terminal.
pub trait CommandSessionExt {
	/// Arranges for the command to run in a new POSIX session with no controlling terminal.
	fn detach_session(&mut self);
	/// Like [`CommandSessionExt::detach_session`], but additionally double-forks
	/// so the spawned process reparents to init (PID 1) and leaves the caller's
	/// descendant tree.
	///
	/// Returns a receiver for the real (grandchild) pid, or `None` when the
	/// report channel could not be set up; the launch itself is unaffected.
	fn detach_session_reparent(&mut self) -> Option<ReparentedPidReceiver>;
}

impl CommandSessionExt for std::process::Command {
	fn detach_session(&mut self) {
		// SAFETY:
		// This arranges for a provided function to run in the forked child
		// before exec. `setsid(2)` is async-signal-safe.
		unsafe {
			self.pre_exec(pre_exec_detach_session);
		}
	}

	fn detach_session_reparent(&mut self) -> Option<ReparentedPidReceiver> {
		let receiver = ReparentedPidReceiver::new();
		let report = receiver.as_ref().map(ReparentedPidReceiver::report_target);
		// SAFETY:
		// This arranges for a provided function to run in the forked child before
		// exec. Only async-signal-safe calls (`setsid`, `fork`, `getpgrp`,
		// `fstat`, `write`, `_exit`) are used.
		unsafe {
			self.pre_exec(move || pre_exec_detach_session_reparent(report));
		}
		receiver
	}
}

/// Where the intermediate child of a reparented launch reports the grandchild.
#[derive(Clone, Copy)]
struct ReparentReportTarget {
	fd:  libc::c_int,
	dev: libc::dev_t,
	ino: libc::ino_t,
}

/// Parent side of the channel over which a reparented launch's intermediate
/// child reports the real (double-forked) grandchild's pid and process group.
///
/// The intermediate writes both ids into a `CLOEXEC` pipe before `_exit(0)`;
/// the grandchild's copy closes on `exec`. `std::process::Command::spawn`
/// only returns once every holder of its own `CLOEXEC` error pipe — which
/// includes the intermediate — has exited or exec'd, so by the time
/// [`ReparentedPidReceiver::receive`] runs the report is either fully buffered
/// or will never arrive. The read end is non-blocking, so a missing report
/// yields `None` instead of stalling the shell.
pub struct ReparentedPidReceiver {
	read:   std::os::fd::OwnedFd,
	write:  std::os::fd::OwnedFd,
	target: ReparentReportTarget,
}

impl ReparentedPidReceiver {
	/// Lowest descriptor number for the write end the intermediate child
	/// inherits: above the range user redirections (`3>…`, `51>…`) and the
	/// shell's own low descriptors occupy, so a child fd mapping's `dup2` does
	/// not close it before the intermediate reports.
	const REPORT_FD_FLOOR: libc::c_int = 512;

	fn new() -> Option<Self> {
		use std::os::fd::AsRawFd;

		let (read, write) = cloexec_pipe()?;
		let write = high_cloexec_fd(write, Self::REPORT_FD_FLOOR);
		// Non-blocking read end: see the type docs.
		// SAFETY: `read` is an open descriptor owned by this process.
		let flags = unsafe { libc::fcntl(read.as_raw_fd(), libc::F_GETFL) };
		// SAFETY: as above; setting status flags does not touch caller memory.
		if flags < 0
			|| unsafe { libc::fcntl(read.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
		{
			return None;
		}
		// Record the write end's identity so the intermediate can detect the
		// descriptor number having been clobbered by a child fd mapping
		// (`inject_fds` runs its `dup2`s before this hook) that still reached it.
		// SAFETY: `stat` is plain-old-data; zeroed is a valid initial value.
		let mut stat: libc::stat = unsafe { std::mem::zeroed() };
		// SAFETY: `write` is open and `stat` is a valid out-pointer.
		if unsafe { libc::fstat(write.as_raw_fd(), &raw mut stat) } != 0 {
			return None;
		}
		let target = ReparentReportTarget { fd: write.as_raw_fd(), dev: stat.st_dev, ino: stat.st_ino };
		Some(Self { read, write, target })
	}

	const fn report_target(&self) -> ReparentReportTarget {
		self.target
	}

	/// Returns the real reparented process' `(pid, pgid)` once the launch has
	/// been spawned successfully, or `None` if it was not reported.
	pub fn receive(self) -> Option<(i32, i32)> {
		use std::os::fd::AsRawFd;

		drop(self.write);
		let mut buf = [0u8; 8];
		let mut filled = 0;
		while filled < buf.len() {
			// SAFETY: the destination range lies within `buf`, and `read` is open.
			let n = unsafe {
				libc::read(
					self.read.as_raw_fd(),
					buf[filled..].as_mut_ptr().cast(),
					buf.len() - filled,
				)
			};
			if n > 0 {
				filled += n.cast_unsigned();
			} else if n < 0 && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted
			{
				continue;
			} else {
				return None;
			}
		}
		let pid = i32::from_ne_bytes(buf[..4].try_into().ok()?);
		let pgid = i32::from_ne_bytes(buf[4..].try_into().ok()?);
		(pid > 0).then_some((pid, pgid))
	}
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn cloexec_pipe() -> Option<(std::os::fd::OwnedFd, std::os::fd::OwnedFd)> {
	use std::os::fd::AsRawFd;

	// No `pipe2` on Apple platforms; set `FD_CLOEXEC` right after creation.
	let (read, write) = nix::unistd::pipe().ok()?;
	for fd in [&read, &write] {
		// SAFETY: `fd` is an open descriptor owned by this process.
		if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
			return None;
		}
	}
	Some((read, write))
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
fn cloexec_pipe() -> Option<(std::os::fd::OwnedFd, std::os::fd::OwnedFd)> {
	nix::unistd::pipe2(nix::fcntl::OFlag::O_CLOEXEC).ok()
}

/// Moves `fd` to the lowest free descriptor number at or above `floor`
/// (`F_DUPFD_CLOEXEC`), closing the original. Keeps `fd` where it is when no
/// such number is available (e.g. `RLIMIT_NOFILE` below `floor`).
fn high_cloexec_fd(fd: std::os::fd::OwnedFd, floor: libc::c_int) -> std::os::fd::OwnedFd {
	use std::os::fd::{AsRawFd, FromRawFd};

	if fd.as_raw_fd() >= floor {
		return fd;
	}
	// SAFETY: `fd` is open and owned; `F_DUPFD_CLOEXEC` returns a new
	// descriptor or -1 and touches no caller memory.
	let high = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_DUPFD_CLOEXEC, floor) };
	if high < 0 {
		return fd;
	}
	// SAFETY: `high` was just returned by `fcntl` and is owned by nobody else.
	unsafe { std::os::fd::OwnedFd::from_raw_fd(high) }
}

fn pre_exec_take_foreground() -> Result<(), std::io::Error> {
	use crate::sys;

	sys::terminal::move_self_to_foreground()?;
	Ok(())
}

fn pre_exec_lead_session() -> Result<(), std::io::Error> {
	if let Err(e) = nix::unistd::setsid() {
		return Err(std::io::Error::other(format!("failed to become session leader: {e}")));
	}

	#[cfg(not(target_os = "macos"))]
	let control = libc::TIOCSCTTY;
	#[cfg(target_os = "macos")]
	let control: u64 = libc::TIOCSCTTY.into();

	// SAFETY:
	// This is calling a libc function to set the controlling terminal.
	let result = unsafe { libc::ioctl(0, control, 0) };
	if result != 0 {
		return Err(std::io::Error::other("failed to set controlling terminal"));
	}

	Ok(())
}

fn pre_exec_detach_session() -> Result<(), std::io::Error> {
	match nix::unistd::setsid() {
		Ok(_) | Err(nix::errno::Errno::EPERM) => Ok(()),
		Err(errno) => Err(std::io::Error::from_raw_os_error(errno as i32)),
	}
}

fn pre_exec_detach_session_reparent(
	report: Option<ReparentReportTarget>,
) -> Result<(), std::io::Error> {
	// New session first: drop any controlling terminal. Ignore EPERM, which means
	// the child is already a session leader from an outer policy.
	match nix::unistd::setsid() {
		Ok(_) | Err(nix::errno::Errno::EPERM) => {},
		Err(errno) => return Err(std::io::Error::from_raw_os_error(errno as i32)),
	}

	// Double-fork: the intermediate child — the pid the parent's spawn machinery
	// tracks — exits immediately, so the grandchild that goes on to `exec` the
	// operand reparents to init (PID 1) and is no longer a descendant of the
	// shell. This is what lets `nohup cmd &` survive the host's descendant-walk
	// teardown without relying on an external `setsid(1)` binary.
	//
	// SAFETY: the post-`fork` child here is single-threaded, and only
	// async-signal-safe primitives (`fork`, `getpgrp`, `fstat`, `write`,
	// `_exit`) run before `exec`.
	let pid = unsafe { libc::fork() };
	if pid < 0 {
		return Err(std::io::Error::last_os_error());
	}
	if pid > 0 {
		// Intermediate parent: report the grandchild's identity to the shell,
		// then exit to orphan it.
		if let Some(report) = report {
			// SAFETY: async-signal-safe; see above.
			let pgid = unsafe { libc::getpgrp() };
			report_reparented_pid(report, pid, pgid);
		}
		// `_exit` avoids running atexit handlers or flushing inherited buffers
		// in the fork.
		// SAFETY: this post-fork intermediate child must terminate without
		// running destructors or touching inherited buffered state.
		unsafe { libc::_exit(0) };
	}
	Ok(())
}

/// Writes `(pid, pgid)` to the report pipe from the post-`fork` intermediate.
/// Async-signal-safe: `fstat` and `write` only, no allocation.
fn report_reparented_pid(report: ReparentReportTarget, pid: libc::pid_t, pgid: libc::pid_t) {
	// SAFETY: `stat` is plain-old-data; zeroed is a valid initial value.
	let mut stat: libc::stat = unsafe { std::mem::zeroed() };
	// SAFETY: `stat` is a valid out-pointer; a closed or reused descriptor
	// number fails or mismatches below rather than touching caller memory.
	if unsafe { libc::fstat(report.fd, &raw mut stat) } != 0
		|| stat.st_dev != report.dev
		|| stat.st_ino != report.ino
	{
		return;
	}
	let mut buf = [0u8; 8];
	buf[..4].copy_from_slice(&pid.to_ne_bytes());
	buf[4..].copy_from_slice(&pgid.to_ne_bytes());
	let mut written = 0;
	while written < buf.len() {
		// SAFETY: the source range lies within `buf`.
		let n = unsafe {
			libc::write(report.fd, buf[written..].as_ptr().cast(), buf.len() - written)
		};
		if n > 0 {
			written += n.cast_unsigned();
		} else if n < 0 && nix::errno::Errno::last() == nix::errno::Errno::EINTR {
			continue;
		} else {
			return;
		}
	}
}

#[cfg(test)]
mod tests {
	use std::{
		os::fd::{AsRawFd, FromRawFd, OwnedFd},
		process::{Command, Stdio},
	};

	use command_fds::{CommandFdExt, FdMapping};

	use super::{CommandSessionExt, ReparentedPidReceiver};

	/// `/dev/null` at a descriptor number of at least `floor`, leaving the low
	/// numbers free.
	fn dev_null_at_or_above(floor: libc::c_int) -> OwnedFd {
		let file = std::fs::File::open("/dev/null").expect("open /dev/null");
		// SAFETY: `file` is open; `F_DUPFD_CLOEXEC` returns a new descriptor.
		let fd = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_DUPFD_CLOEXEC, floor) };
		assert!(fd >= floor, "F_DUPFD_CLOEXEC failed");
		// SAFETY: `fd` was just created and is owned by nobody else.
		unsafe { OwnedFd::from_raw_fd(fd) }
	}

	/// A child fd mapping onto the number the report pipe was created at (a
	/// user redirection like `51>/dev/null`) must not stop the intermediate
	/// from reporting the reparented grandchild.
	#[test]
	fn report_survives_child_fd_mappings_over_low_descriptors() {
		const LOW: std::ops::RangeInclusive<libc::c_int> = 3..=96;

		// Mapping sources live high, so the report pipe is created at the
		// lowest free descriptor — inside `LOW` — as in a host whose low
		// numbers are free when the launch starts.
		let mappings: Vec<FdMapping> = LOW
			.map(|child_fd| FdMapping { parent_fd: dev_null_at_or_above(2048), child_fd })
			.collect();
		let probe = std::fs::File::open("/dev/null").expect("open /dev/null");
		let pipe_would_land = probe.as_raw_fd();
		drop(probe);
		assert!(LOW.contains(&pipe_would_land), "lowest free fd {pipe_would_land} is not low");

		let mut command = Command::new("/bin/sleep");
		command
			.arg("7405")
			.stdin(Stdio::null())
			.stdout(Stdio::null())
			.stderr(Stdio::null());
		command.fd_mappings(mappings).expect("fd mappings");
		let receiver: Option<ReparentedPidReceiver> = command.detach_session_reparent();
		let receiver = receiver.expect("report channel");
		let mut intermediate = command.spawn().expect("spawn");
		let _ = intermediate.wait();
		let reported = receiver.receive();
		if let Some((pid, _)) = reported {
			// SAFETY: signals exactly the grandchild this test launched.
			unsafe { libc::kill(pid, libc::SIGKILL) };
		}

		let (pid, pgid) = reported.expect("the grandchild must be reported");
		assert!(pid > 0);
		assert_eq!(pgid, i32::try_from(intermediate.id()).expect("pid fits in i32"));
	}
}
