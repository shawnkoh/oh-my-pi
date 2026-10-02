//! `pkill` process-signalling builtin moved from `pi-shell`.

use brush_core::builtins;
use clap::Parser;

use crate::proc_match;

/// Selects processes by name or attributes and sends them a signal.
#[derive(Parser)]
#[command(disable_help_flag = true, disable_version_flag = true)]
pub(crate) struct PkillCommand {
	/// Arguments interpreted by the shared process-matching engine.
	#[arg(num_args = 0.., trailing_var_arg = true, allow_hyphen_values = true)]
	argv: Vec<String>,
}

impl builtins::Command for PkillCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
		proc_match::run(proc_match::ProcMatchMode::Kill, self.argv.clone(), context).await
	}
}

#[cfg(test)]
mod tests {
	use brush_core::{Shell, builtins};

	use super::PkillCommand;

	const NO_MATCH: &str = "^__brush_pkill_test_no_such_process_6f239a1d__$";

	async fn run(args: &str) -> brush_core::ExecutionResult {
		let mut shell = Shell::builder()
			.builtin("pkill", builtins::builtin::<PkillCommand, _>())
			.build()
			.await
			.expect("test shell should build");
		shell
			.run_dash_c_command(format!("pkill {args} {NO_MATCH}"))
			.await
			.expect("pkill should execute")
	}

	#[tokio::test]
	async fn exits_one_when_no_process_matches() {
		assert_eq!(u8::from(run("").await.exit_code), 1);
	}

	#[tokio::test]
	async fn accepts_a_signal_name() {
		assert_eq!(u8::from(run("-TERM").await.exit_code), 1);
	}

	#[tokio::test]
	async fn accepts_a_signal_number() {
		assert_eq!(u8::from(run("-9").await.exit_code), 1);
	}

	/// Makes `pidfd_open` fail with `ENOSYS` on the calling thread only, as
	/// OpenShell's seccomp filter does for every sandboxed process.
	#[cfg(target_os = "linux")]
	fn fail_pidfd_open_on_this_thread() {
		let code = |code: u32| u16::try_from(code).expect("BPF opcode fits u16");
		let pidfd_open = u32::try_from(libc::SYS_pidfd_open).expect("syscall number fits u32");
		let mut program = [
			// `seccomp_data.nr` is at offset 0.
			libc::sock_filter { code: code(libc::BPF_LD | libc::BPF_W | libc::BPF_ABS), jt: 0, jf: 0, k: 0 },
			libc::sock_filter {
				code: code(libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K),
				jt:   0,
				jf:   1,
				k:    pidfd_open,
			},
			libc::sock_filter {
				code: code(libc::BPF_RET | libc::BPF_K),
				jt:   0,
				jf:   0,
				k:    libc::SECCOMP_RET_ERRNO | libc::ENOSYS.cast_unsigned(),
			},
			libc::sock_filter {
				code: code(libc::BPF_RET | libc::BPF_K),
				jt:   0,
				jf:   0,
				k:    libc::SECCOMP_RET_ALLOW,
			},
		];
		let filter = libc::sock_fprog {
			len:    u16::try_from(program.len()).expect("program length fits u16"),
			filter: program.as_mut_ptr(),
		};
		// SAFETY: both calls take scalars and, for the filter, a pointer to a
		// program that stays alive for the call; without
		// `SECCOMP_FILTER_FLAG_TSYNC` only this thread is filtered.
		unsafe {
			assert_eq!(libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0), 0, "no_new_privs");
			assert_eq!(
				libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER, &raw const filter),
				0,
				"install seccomp filter"
			);
		}
	}

	/// Runs `pkill <args>` on a thread where `pidfd_open` is unavailable.
	#[cfg(target_os = "linux")]
	fn run_without_pidfds(args: String) -> brush_core::ExecutionResult {
		std::thread::spawn(move || {
			fail_pidfd_open_on_this_thread();
			tokio::runtime::Builder::new_current_thread()
				.enable_all()
				.build()
				.expect("test runtime")
				.block_on(async {
					let mut shell = Shell::builder()
						.builtin("pkill", builtins::builtin::<PkillCommand, _>())
						.build()
						.await
						.expect("test shell should build");
					shell
						.run_dash_c_command(format!("pkill {args}"))
						.await
						.expect("pkill should execute")
				})
		})
		.join()
		.expect("filtered thread")
	}

	/// Where `pidfd_open` is unavailable (OpenShell), `pkill` still signals the
	/// process it selected.
	#[cfg(target_os = "linux")]
	#[test]
	fn signals_a_process_where_pidfd_open_is_unavailable() {
		use std::os::unix::process::ExitStatusExt as _;

		let mut child = std::process::Command::new("sleep")
			.arg("7543")
			.spawn()
			.expect("spawn sleep");
		let result = run_without_pidfds(format!("-TERM -p {}", child.id()));
		let _ = child.kill();
		let status = child.wait().expect("reap child");
		assert_eq!(u8::from(result.exit_code), 0);
		assert_eq!(status.signal(), Some(libc::SIGTERM), "pkill must have delivered SIGTERM");
	}

	/// Without a pidfd, `pkill` never signals by pid a process that has already
	/// exited: its pid could be recycled the moment it is reaped.
	#[cfg(target_os = "linux")]
	#[test]
	fn never_signals_an_exited_process_where_pidfd_open_is_unavailable() {
		let mut child = std::process::Command::new("sleep")
			.arg("7544")
			.spawn()
			.expect("spawn sleep");
		let pid = child.id();
		child.kill().expect("kill child");
		let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
		while !std::fs::read_to_string(format!("/proc/{pid}/stat"))
			.is_ok_and(|stat| stat.rsplit_once(") ").is_some_and(|(_, rest)| rest.starts_with('Z')))
		{
			assert!(std::time::Instant::now() < deadline, "child never became a zombie");
			std::thread::sleep(std::time::Duration::from_millis(5));
		}
		let result = run_without_pidfds(format!("-TERM -p {pid}"));
		let _ = child.wait();
		assert_eq!(u8::from(result.exit_code), 1, "an exited process must not count as signalled");
	}
}
