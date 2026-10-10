import * as fs from "node:fs";
import type { Writable } from "node:stream";
import { logger, openCloexecSync, TempDir } from "@oh-my-pi/pi-utils";
import type { BunFile } from "bun";

const READ_BYTES = 64 * 1024;

interface Spool {
	dir: TempDir;
	file: BunFile;
	fd: number;
	read: number;
	written: number;
}

/** Synchronous event producers spill to disk while the RPC reader applies backpressure. */
export class RpcOutputWriter {
	#spool: Spool | undefined;
	#blocked = false;
	#pumping = false;
	#pendingWrites = 0;
	#failure: Error | undefined;
	#closing = false;
	#completion: { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } | undefined;
	#deferred:
		| {
				line: string;
				deadline: number;
				complete: (delivered: boolean) => void;
				timer: NodeJS.Timeout;
				prepare?: () => string | undefined;
		  }
		| undefined;
	#deferredTurn: NodeJS.Immediate | undefined;

	constructor(
		private readonly sink: Writable,
		private readonly onFailure: (error: Error) => void,
	) {
		sink.on("drain", this.#onDrain);
		sink.on("error", this.#onError);
		sink.on("close", this.#onClose);
		process.once("exit", this.#onExit);
	}

	write(frames: Iterable<string>): void {
		if (this.#failure || this.#closing) return;
		try {
			for (const line of frames) {
				if (this.#blocked || this.#pumping || this.#spool) this.#append(line);
				else this.#write(line);
			}
		} catch (error) {
			this.#fail(error);
		}
	}

	/**
	 * Hold one bounded history response outside the ordinary spool. Ordinary frames
	 * already accepted by write() take priority; an unsent frame can be discarded.
	 * Once passed to sink.write, credit remains held until its write callback.
	 */
	defer(
		line: string,
		deadline: number,
		complete: (delivered: boolean) => void,
		prepare?: () => string | undefined,
	): () => void {
		if (this.#deferred) throw new Error("RPC deferred output slot occupied");
		if (this.#failure || this.#closing || deadline <= performance.now()) {
			complete(false);
			return () => {};
		}
		const timer = setTimeout(() => this.#discardDeferred(), Math.max(0, deadline - performance.now()));
		timer.unref();
		this.#deferred = { line, deadline, complete, timer, prepare };
		this.#scheduleDeferred();
		return () => this.#discardDeferred();
	}

	async close(): Promise<void> {
		this.#closing = true;
		this.#discardDeferred();
		if (this.#failure) throw this.#failure;
		if (this.#pendingWrites || this.#spool || this.#pumping) {
			this.#completion ??= Promise.withResolvers<void>();
			await this.#completion.promise;
		}
		this.sink.off("drain", this.#onDrain);
		this.sink.off("error", this.#onError);
		this.sink.off("close", this.#onClose);
		process.off("exit", this.#onExit);
	}

	#write(bytes: string | Uint8Array, complete?: (delivered: boolean) => void): void {
		this.#pendingWrites++;
		this.#blocked = !this.sink.write(bytes, error => {
			this.#pendingWrites--;
			if (error) this.#fail(error);
			complete?.(!error);
			if (!error) this.#settle();
		});
	}

	#append(line: string): void {
		if (!this.#spool) {
			const dir = TempDir.createSync("@omp-rpc-output-");
			try {
				const file = dir.join("output");
				const handle = Bun.file(file);
				const fd = openCloexecSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
				this.#spool = { dir, file: handle, fd, read: 0, written: 0 };
			} catch (error) {
				dir.removeSync();
				throw error;
			}
		}
		const spool = this.#spool;
		const bytes = Buffer.from(line);
		let offset = 0;
		// Event callbacks cannot await a disk write without retaining an unbounded queue.
		while (offset < bytes.length) {
			const written = fs.writeSync(spool.fd, bytes, offset, bytes.length - offset, spool.written);
			if (written === 0) throw new Error("RPC output spool write made no progress");
			offset += written;
			spool.written += written;
		}
	}

	#onDrain = (): void => {
		this.#blocked = false;
		void this.#pump();
	};

	#onError = (error: Error): void => this.#fail(error);
	#onClose = (): void => this.#fail(new Error("RPC output closed before delivery completed"));
	#onExit = (): void => {
		try {
			this.#removeSpool();
		} catch (error) {
			logger.warn("RPC output spool cleanup failed", { error: String(error) });
		}
	};

	async #pump(): Promise<void> {
		if (this.#pumping || this.#failure) return;
		this.#pumping = true;
		try {
			while (this.#spool && !this.#blocked && !this.#failure) {
				const spool = this.#spool;
				const end = Math.min(spool.written, spool.read + READ_BYTES);
				const bytes = await spool.file.slice(spool.read, end).bytes();
				if (this.#failure) break;
				if (bytes.length !== end - spool.read) throw new Error("RPC output spool ended before delivery completed");
				spool.read = end;
				this.#write(bytes);
				if (spool.read === spool.written) this.#removeSpool();
			}
		} catch (error) {
			this.#fail(error);
		} finally {
			this.#pumping = false;
			this.#settle();
		}
	}

	#removeSpool(): void {
		const spool = this.#spool;
		if (!spool) return;
		this.#spool = undefined;
		try {
			fs.closeSync(spool.fd);
		} finally {
			spool.dir.removeSync();
		}
	}

	#scheduleDeferred(): void {
		if (this.#deferredTurn || !this.#deferred || this.#blocked || this.#pendingWrites || this.#spool || this.#pumping)
			return;
		// Let ordinary responses produced in this event-loop turn enter the writer first.
		this.#deferredTurn = setImmediate(() => {
			this.#deferredTurn = undefined;
			const pending = this.#deferred;
			if (!pending || this.#blocked || this.#pendingWrites || this.#spool || this.#pumping) return;
			if (performance.now() >= pending.deadline || this.#failure || this.#closing) {
				this.#discardDeferred();
				return;
			}
			this.#deferred = undefined;
			clearTimeout(pending.timer);
			const line = pending.prepare ? pending.prepare() : pending.line;
			if (line === undefined) pending.complete(false);
			else {
				try {
					this.#write(line, pending.complete);
				} catch (error) {
					pending.complete(false);
					this.#fail(error);
				}
			}
		});
	}

	#discardDeferred(): void {
		const pending = this.#deferred;
		if (!pending) return;
		this.#deferred = undefined;
		clearTimeout(pending.timer);
		pending.complete(false);
	}

	#settle(): void {
		if (!this.#pendingWrites && !this.#spool && !this.#pumping && !this.#failure) {
			this.#completion?.resolve();
			this.#scheduleDeferred();
		}
	}

	#fail(error: unknown): void {
		if (this.#failure) return;
		this.#discardDeferred();
		this.#failure = error instanceof Error ? error : new Error(String(error));
		try {
			this.#removeSpool();
		} catch (cleanupError) {
			this.#failure = new AggregateError(
				[this.#failure, cleanupError],
				"RPC output failed and spool cleanup failed",
			);
		}
		this.#completion?.reject(this.#failure);
		process.off("exit", this.#onExit);
		this.onFailure(this.#failure);
	}
}
