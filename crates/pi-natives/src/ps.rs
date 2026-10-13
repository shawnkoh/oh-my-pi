//! N-API bindings for cross-platform process tree management.
//!
//! The platform-specific implementation lives in [`pi_shell::process`]; this
//! module is a thin shim that exposes that crate's `Process` surface to
//! JavaScript and re-exports the termination primitives used by other native
//! modules (e.g. [`crate::pty`]).

use std::time::Duration;

use napi::{
	Env, JsString, Result,
	bindgen_prelude::{PromiseRaw, Unknown},
};
use napi_derive::napi;
use pi_shell::process::{self as core_process, ProcessStatus as CoreProcessStatus};
pub use pi_shell::process::{KILL_SIGNAL, TERM_SIGNAL, TerminationTargets, kill_process_group};

use crate::{js::into_string, task};

#[derive(Default)]
#[napi(object)]
pub struct ProcessTerminateOptions<'env> {
	/// Also signal the process group when supported by the platform.
	pub group:       Option<bool>,
	/// Milliseconds to wait after polite termination before hard-killing.
	/// Omit to use the default grace period. Pass a negative value to skip the
	/// graceful phase and hard-kill immediately.
	pub graceful_ms: Option<i32>,
	/// Milliseconds to wait after hard-kill for the process tree to exit.
	pub timeout_ms:  Option<u32>,
	/// Abort signal for cancelling termination while waiting.
	pub signal:      Option<Unknown<'env>>,
}

/// Options for waiting on a process exit.
#[derive(Default)]
#[napi(object)]
pub struct ProcessWaitOptions<'env> {
	/// Milliseconds to wait before returning false. Omit to wait indefinitely.
	pub timeout_ms: Option<u32>,
	/// Abort signal for cancelling the wait.
	pub signal:     Option<Unknown<'env>>,
}

/// Current state of a process reference.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi(string_enum)]
pub enum ProcessStatus {
	/// The referenced process is still running.
	#[napi(value = "running")]
	Running,
	/// The referenced process has exited or is no longer observable.
	#[napi(value = "exited")]
	Exited,
}

impl From<CoreProcessStatus> for ProcessStatus {
	fn from(value: CoreProcessStatus) -> Self {
		match value {
			CoreProcessStatus::Running => Self::Running,
			CoreProcessStatus::Exited => Self::Exited,
		}
	}
}

/// Stable process reference.
#[napi]
#[derive(Clone)]
pub struct Process {
	inner: core_process::Process,
}

#[napi]
#[allow(clippy::use_self, reason = "napi return types must name the exported class")]
impl Process {
	/// Open a stable process reference from a PID.
	#[napi]
	pub fn from_pid(pid: i32) -> Option<Process> {
		core_process::Process::from_pid(pid).map(Self::from_inner)
	}

	/// Open stable process references whose executable path matches exactly.
	#[napi]
	pub fn from_path(path: JsString) -> Result<Vec<Process>> {
		Ok(core_process::Process::from_path(into_string(path)?)
			.into_iter()
			.map(Self::from_inner)
			.collect())
	}

	/// Operating-system process identifier for this process reference.
	#[napi(getter)]
	pub const fn pid(&self) -> i32 {
		self.inner.pid()
	}

	/// Parent process id for this process, when available.
	#[napi(getter)]
	pub fn ppid(&self) -> Option<i32> {
		self.inner.ppid()
	}

	/// Launch arguments for this process.
	#[napi]
	pub fn args(&self) -> Vec<String> {
		self.inner.args()
	}

	/// Send `signal` to this process and its descendants, children first.
	///
	/// On Linux and macOS the signal is forwarded as-is. On Windows there is no
	/// signal abstraction, so the `signal` argument is ignored and the entire
	/// tree is hard-killed via `TerminateProcess`. Defaults to the POSIX
	/// hard-kill signal.
	#[napi]
	pub fn kill_tree(&self, signal: Option<i32>) -> u32 {
		self.inner.kill_tree(signal)
	}

	/// Gracefully terminate this process and its descendants.
	///
	/// By default this waits 1000ms after polite termination before
	/// hard-killing. Pass `graceful_ms < 0` to skip the graceful phase.
	#[napi]
	pub fn terminate<'env>(
		&self,
		env: &'env Env,
		options: Option<ProcessTerminateOptions<'env>>,
	) -> Result<PromiseRaw<'env, bool>> {
		let options = options.unwrap_or_default();
		let group = options.group.unwrap_or(false);
		let graceful_ms = options.graceful_ms.unwrap_or(1000);
		let timeout_ms = options.timeout_ms.unwrap_or(5000);
		let ct = task::CancelToken::new(None, options.signal);
		let process = self.inner.clone();
		task::future(env, "process.terminate", async move {
			process
				.terminate_tree(group, graceful_ms, timeout_ms, ct.into_core())
				.await
				.map_err(|err| napi::Error::from_reason(err.to_string()))
		})
	}

	/// Wait until this process exits.
	///
	/// When `options.timeout_ms` is omitted, waits until the process exits.
	#[napi]
	pub fn wait_for_exit<'env>(
		&self,
		env: &'env Env,
		options: Option<ProcessWaitOptions<'env>>,
	) -> Result<PromiseRaw<'env, bool>> {
		let options = options.unwrap_or_default();
		let ct = task::CancelToken::new(None, options.signal);
		let timeout = options
			.timeout_ms
			.map(|ms| Duration::from_millis(u64::from(ms)));
		let process = self.inner.clone();
		task::future(env, "process.wait_for_exit", async move {
			process
				.wait_for_exit(timeout, ct.into_core())
				.await
				.map_err(|err| napi::Error::from_reason(err.to_string()))
		})
	}

	/// Process group id for this process, when supported by the platform.
	#[napi]
	#[allow(clippy::missing_const_for_fn, reason = "#[napi] generates a non-const wrapper")]
	pub fn group_id(&self) -> Option<i32> {
		self.inner.group_id()
	}

	/// Direct children of this process as stable process references.
	#[napi]
	pub fn children(&self) -> Vec<Process> {
		self
			.inner
			.children()
			.into_iter()
			.map(Self::from_inner)
			.collect()
	}

	/// Current status of this process reference.
	#[napi]
	pub fn status(&self) -> ProcessStatus {
		self.inner.status().into()
	}
}

impl Process {
	const fn from_inner(inner: core_process::Process) -> Self {
		Self { inner }
	}
}

/// Clock-independent identity of a process at a moment.
#[napi(object)]
pub struct ProcessIdentity {
	/// running: exists and is not a zombie. gone: no such process
	/// (ESRCH/ENOENT) or a zombie/dead entry. unreadable: exists (or cannot be
	/// proven gone) but its identity cannot be read (EPERM, hidepid,
	/// setuid/non-dumpable).
	#[napi(ts_type = "'running' | 'gone' | 'unreadable'")]
	pub state:      String,
	/// Opaque start identity, decimal string, comparable only for equality
	/// (and numerically within one host+boot): Linux raw `/proc/<pid>/stat`
	/// field 22 (start ticks since boot), macOS
	/// `pbi_start_tvsec*1_000_000+pbi_start_tvusec`, Windows raw creation
	/// `FILETIME`. Present only when state === "running".
	pub start_id:   Option<String>,
	/// Display only: Unix epoch seconds (floor). Present only when
	/// state === "running".
	pub start_time: Option<i64>,
}

/// Current identity of `pid`; see `ProcessIdentity`.
#[napi]
pub fn process_identity(pid: i32) -> ProcessIdentity {
	let identity = core_process::process_identity(pid);
	let state = match identity.state {
		core_process::IdentityState::Running => "running",
		core_process::IdentityState::Gone => "gone",
		core_process::IdentityState::Unreadable => "unreadable",
	};
	ProcessIdentity {
		state:      state.to_owned(),
		start_id:   identity.start_id.map(|id| id.to_string()),
		start_time: identity
			.start_time
			.and_then(|secs| i64::try_from(secs).ok()),
	}
}

/// A live process whose environment carries a marker token.
#[napi(object)]
pub struct MarkedProcess {
	pub pid:        i32,
	pub ppid:       i32,
	/// Process group id when readable.
	pub pgid:       Option<i32>,
	/// OS start time, Unix epoch seconds (floor) — the same value as
	/// `processIdentity(pid).startTime`. Display only.
	pub start_time: Option<i64>,
	/// Opaque start identity — the same value as
	/// `processIdentity(pid).startId`.
	pub start_id:   Option<String>,
	/// Executable name (best effort, may be truncated).
	pub command:    String,
	/// The first of the requested tokens (in request order) the process
	/// carries. Absent for `opaque` entries.
	pub token:      Option<String>,
}

/// Result of `scanProcessesByEnv`.
#[napi(object)]
pub struct MarkedProcessScan {
	/// False on platforms without an implementation (Windows), or when the
	/// process table could not be listed: callers must treat the result as
	/// unknown.
	pub supported:  bool,
	/// True when the platform may hide processes of this user from the scan
	/// altogether (Linux `/proc` mounted with `hidepid` other than 0/off, or
	/// whose mount options cannot be read): the result is not a complete
	/// census, whatever `opaque` says. False on macOS.
	pub hidden:     bool,
	pub processes:  Vec<MarkedProcess>,
	/// Candidate processes examined: those whose real, effective or saved uid
	/// is the caller's, or whose uids cannot be read.
	pub scanned:    u32,
	/// Candidates that were alive but whose environment (or start time) could
	/// not be read (not counting ones that exited mid-scan).
	pub unreadable: u32,
	/// Candidates whose environment came back empty. macOS withholds the
	/// environment of Apple platform binaries (`/bin/sh`, `zsh`,
	/// `/bin/sleep`, …), so a marker on such a process is not visible and it
	/// is counted here instead.
	pub redacted:   u32,
	/// The unreadable and redacted processes whose start id is at or after
	/// `opaqueSince`, or unknown (empty when `opaqueSince` was not given): the
	/// only ones that could hide a marker set no earlier than that instant.
	pub opaque:     Vec<MarkedProcess>,
}

fn to_napi(entry: core_process::MarkedProcess) -> MarkedProcess {
	MarkedProcess {
		pid:        entry.pid,
		ppid:       entry.ppid,
		pgid:       entry.pgid,
		start_time: entry.start_time.and_then(|secs| i64::try_from(secs).ok()),
		start_id:   entry.start_id.map(|id| id.to_string()),
		command:    entry.command,
		token:      entry.token,
	}
}

/// Live processes of the calling user whose environment carries a marker.
///
/// Every live process of the calling user (excluding the caller itself) whose
/// environment variable `name` is set and whose value, split on ',', contains
/// any of `tokens` exactly; no tokens match nothing. A process is the user's
/// when its real, effective or saved uid is the caller's (so setuid launches
/// count); one whose uids cannot be read is examined too. `opaqueSince` is a
/// `startId` of this host and boot (compared numerically): processes with an
/// unexaminable environment whose start id is at or after it, or unknown, are
/// listed in `opaque`.
///
/// # Errors
/// Throws when `opaqueSince` is not a decimal start id.
#[napi]
pub fn scan_processes_by_env(
	name: String,
	tokens: Vec<String>,
	opaque_since: Option<String>,
) -> Result<MarkedProcessScan> {
	let since = opaque_since
		.map(|since| {
			since.parse::<u64>().map_err(|_| {
				napi::Error::new(
					napi::Status::InvalidArg,
					format!("opaqueSince must be a decimal startId, got {since:?}"),
				)
			})
		})
		.transpose()?;
	let tokens: Vec<&str> = tokens.iter().map(String::as_str).collect();
	let scan = core_process::scan_processes_by_env(&name, &tokens, since);
	Ok(MarkedProcessScan {
		supported:  scan.supported,
		hidden:     scan.hidden,
		processes:  scan.processes.into_iter().map(to_napi).collect(),
		scanned:    scan.scanned,
		unreadable: scan.unreadable,
		redacted:   scan.redacted,
		opaque:     scan.opaque.into_iter().map(to_napi).collect(),
	})
}

/// Replace the current process image via `execvp(3)`.
///
/// On success this never returns: the kernel tears down every other thread and
/// the new program takes over this PID, controlling terminal, and inherited
/// (non-`CLOEXEC`) file descriptors. Callers must flush logs and restore the
/// terminal first — no JS or native cleanup runs after a successful call.
///
/// # Errors
/// Returns an error, leaving the process untouched, when `argv` is empty, an
/// argument contains an interior NUL byte, or the exec itself fails (e.g.
/// executable not found). Windows has no exec-replace semantics, so this
/// always errors there; callers fall back to spawn-and-wait.
#[napi]
pub fn exec_replace(argv: Vec<String>) -> Result<()> {
	#[cfg(unix)]
	{
		use std::ffi::CString;

		if argv.is_empty() {
			return Err(napi::Error::from_reason("exec_replace: argv must not be empty"));
		}
		let args = argv
			.into_iter()
			.map(CString::new)
			.collect::<std::result::Result<Vec<_>, _>>()
			.map_err(|err| napi::Error::from_reason(format!("exec_replace: {err}")))?;
		let mut ptrs: Vec<*const libc::c_char> = args.iter().map(|arg| arg.as_ptr()).collect();
		ptrs.push(std::ptr::null());
		// SAFETY: `ptrs` is a NUL-terminated array of pointers into `args`, which
		// outlives the call; execvp only returns on failure.
		unsafe { libc::execvp(ptrs[0], ptrs.as_ptr()) };
		Err(napi::Error::from_reason(format!("execvp failed: {}", std::io::Error::last_os_error())))
	}
	#[cfg(not(unix))]
	{
		let _ = argv;
		Err(napi::Error::from_reason("exec_replace is unsupported on this platform"))
	}
}
