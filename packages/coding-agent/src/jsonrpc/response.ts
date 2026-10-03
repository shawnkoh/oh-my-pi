interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: string | number;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

/** Only a well-formed response can settle work; request ids belong to a separate namespace. */
export function isJsonRpcResponse(message: unknown): message is JsonRpcResponse {
	if (!message || typeof message !== "object" || Array.isArray(message)) return false;
	if (!("jsonrpc" in message) || message.jsonrpc !== "2.0" || "method" in message) return false;
	if (!("id" in message) || (typeof message.id !== "string" && typeof message.id !== "number")) return false;
	if (typeof message.id === "number" && !Number.isFinite(message.id)) return false;
	const hasResult = Object.hasOwn(message, "result");
	const hasError = Object.hasOwn(message, "error");
	if (hasResult === hasError) return false;
	if (hasResult) return true;
	const error = (message as JsonRpcResponse).error;
	return (
		error !== null && typeof error === "object" && Number.isInteger(error.code) && typeof error.message === "string"
	);
}
