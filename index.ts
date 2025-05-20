// --- TYPES ---
type HttpMethod =
	| "GET"
	| "POST"
	| "PUT"
	| "DELETE"
	| "PATCH"
	| "OPTIONS"
	| "HEAD";

type HttpMethodValue = HttpMethod | HttpMethod[] | "*";

const VALID_METHODS: HttpMethod[] = [
	"GET",
	"POST",
	"PUT",
	"DELETE",
	"PATCH",
	"OPTIONS",
	"HEAD",
];

interface ServiceConfig {
	prefix?: string;
	path?: string;
	method?: HttpMethodValue;
	host: string;
	port: number;
	active?: boolean;
}

interface Config {
	host: string;
	port: number;
	services: ServiceConfig[];
	debug?: boolean;
}

// --- LOGGING ---
enum LogLevel {
	DEBUG = 1,
	INFO = 2,
	ERROR = 3,
}

let currentLogLevel = LogLevel.INFO;

function formatLog(level: string, emoji: string, message: string) {
	return `${emoji} [${level.padEnd(5)} ${new Date().toISOString()}] ${message}`;
}

function log(level: LogLevel, emoji: string, message: string) {
	if (level >= currentLogLevel) {
		const levelStr = LogLevel[level];
		console.log(formatLog(levelStr, emoji, message));
	}
}

function logDebug(message: string) {
	log(LogLevel.DEBUG, "🐛", message);
}

function logInfo(message: string) {
	log(LogLevel.INFO, "📡", message);
}

function logError(message: string) {
	log(LogLevel.ERROR, "❌", message);
}

// --- CONFIG LOADING ---
let config: Config;
let DEBUG = false;

function validateServiceConfig(
	svc: ServiceConfig,
	index: number,
): ServiceConfig {
	const errors: string[] = [];

	if (typeof svc.host !== "string" || !svc.host) {
		errors.push(`Service ${index + 1}: "host" must be a non-empty string`);
	}

	if (typeof svc.port !== "number" || svc.port <= 0) {
		errors.push(`Service ${index + 1}: "port" must be a positive number`);
	}

	let method: HttpMethodValue | undefined = svc.method;

	if (typeof method === "string") {
		if (method === "*") {
			method = "*";
		} else if (VALID_METHODS.includes(method.toUpperCase() as HttpMethod)) {
			method = method.toUpperCase() as HttpMethod;
		} else {
			errors.push(`Service ${index + 1}: Invalid method "${method}"`);
		}
	} else if (Array.isArray(method)) {
		const upperMethods = method.map((m) => m.toUpperCase());
		const invalids = upperMethods.filter(
			(m) => !VALID_METHODS.includes(m as HttpMethod),
		);
		if (invalids.length > 0) {
			errors.push(
				`Service ${index + 1}: Invalid method(s) ${invalids.join(", ")}`,
			);
		} else {
			method = upperMethods as HttpMethod[];
		}
	} else if (method !== undefined && method !== "*") {
		errors.push(
			`Service ${index + 1}: Unsupported method format: ${JSON.stringify(method)}`,
		);
	}

	if (errors.length > 0) {
		throw new Error(errors.join("; "));
	}

	return {
		...svc,
		method,
		active: svc.active !== false,
	};
}

async function loadConfig(): Promise<Config> {
	const cfg = await Bun.file("config.json").json();

	const topErrors: string[] = [];
	if (typeof cfg.host !== "string" || !cfg.host) {
		topErrors.push(`"host" must be a non-empty string`);
	}
	if (typeof cfg.port !== "number" || cfg.port <= 0) {
		topErrors.push(`"port" must be a positive number`);
	}
	if (!Array.isArray(cfg.services)) {
		topErrors.push(`"services" must be an array`);
	}

	if (topErrors.length > 0) {
		throw new Error(topErrors.join("; "));
	}

	try {
		cfg.services = cfg.services.map((svc: ServiceConfig, i: number) =>
			validateServiceConfig(svc, i),
		);
	} catch (validationError) {
		logError(
			`❌ Configuration validation error: ${(validationError as Error).message}`,
		);
		throw validationError;
	}

	DEBUG = cfg.debug ?? false;
	currentLogLevel = DEBUG ? LogLevel.DEBUG : LogLevel.INFO;

	console.clear();
	logInfo("🔁 Configuration loaded");

	logInfo(`🚀 Starting Gateway on http://${cfg.host}:${cfg.port}`);
	logInfo(`🔧 Debug mode: ${DEBUG ? "ON" : "OFF"}`);
	logInfo(`📦 Loaded ${cfg.services.length} services:`);

	cfg.services.forEach((svc: ServiceConfig, i: number) => {
		const label = svc.path
			? `path: ${Array.isArray(svc.method) ? svc.method.join(",") : svc.method} ${svc.path}`
			: svc.prefix
				? `prefix: ${svc.prefix}`
				: "<no path or prefix>";
		logInfo(`  ${i + 1}. ${label} => ${svc.host}:${svc.port}`);
	});

	return cfg;
}

// --- UTILITIES ---
const hopByHopHeaders = [
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailers",
	"transfer-encoding",
	"upgrade",
];

function sanitizeHeaders(headers: Headers): Headers {
	const sanitized = new Headers();
	headers.forEach((value, key) => {
		if (!hopByHopHeaders.includes(key.toLowerCase())) {
			sanitized.append(key, value);
		}
	});
	return sanitized;
}

function buildTargetUrl(req: Request, svc: ServiceConfig): string {
	const reqUrl = new URL(req.url);
	return `http://${svc.host}:${svc.port}${reqUrl.pathname}${reqUrl.search}`;
}

function prepareForwardedRequest(
	req: Request,
	svc: ServiceConfig,
	targetUrl: string,
): Request {
	const headers = sanitizeHeaders(req.headers);

	if (!headers.has("host")) {
		headers.set("host", `${svc.host}:${svc.port}`);
	}

	const origin = req.headers.get("origin");
	if (origin) {
		headers.set("origin", origin);
	}

	const originalXFF = req.headers.get("x-forwarded-for");
	const clientIp = req.headers.get("cf-connecting-ip") || "unknown";
	const xff = originalXFF ? `${originalXFF}, ${clientIp}` : clientIp;
	headers.set("x-forwarded-for", xff);

	return new Request(targetUrl, {
		method: req.method,
		headers,
		body: req.body,
		redirect: "manual",
	});
}

async function forwardRequest(
	req: Request,
	svc: ServiceConfig,
): Promise<Response> {
	const targetUrl = buildTargetUrl(req, svc);
	logDebug(`➡️ Forwarding request to: ${targetUrl}`);

	try {
		const forwardedReq = prepareForwardedRequest(req, svc, targetUrl);
		const response = await fetch(forwardedReq);
		logDebug(`⬅️ Received ${response.status} from ${svc.host}:${svc.port}`);
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	} catch (error: unknown) {
		const errMsg =
			error instanceof Error ? error.stack || error.message : String(error);
		if (DEBUG) {
			logError(`💥 Failed to forward to ${targetUrl}: ${errMsg}`);
		} else {
			logError(
				`💥 Failed to forward to ${targetUrl}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return new Response("Bad Gateway", { status: 502 });
	}
}

function matchService(req: Request): ServiceConfig | undefined {
	const reqUrl = new URL(req.url);
	const pathname =
		reqUrl.pathname === "/" ? "/" : reqUrl.pathname.replace(/\/+$/, "");
	const method = req.method.toUpperCase() as HttpMethod;

	const exactMatch = config.services.find(
		(svc) => svc.active && svc.path === pathname && svc.method === method,
	);
	if (exactMatch) {
		logDebug(`✅ Exact match: ${method} ${pathname}`);
		return exactMatch;
	}

	const prefixMatch = config.services.find(
		(svc) => svc.active && svc.prefix && pathname.startsWith(svc.prefix),
	);
	if (prefixMatch) {
		logDebug(`🔎 Prefix match: ${pathname} starts with ${prefixMatch.prefix}`);
		return prefixMatch;
	}

	logDebug(`❓ No match found for ${method} ${pathname}`);
	return undefined;
}

// --- SERVER SETUP ---
async function startServer() {
	try {
		config = await loadConfig();
	} catch (err) {
		logError(`❌ Failed to load config: ${(err as Error).message}`);
		process.exit(1);
	}

	const server = Bun.serve({
		hostname: config.host,
		port: config.port,
		async fetch(req: Request) {
			const url = new URL(req.url);
			const pathname = url.pathname;

			logDebug(`📥 Incoming: ${req.method} ${pathname}`);

			if (pathname === "/__health") {
				return new Response("✅ Gateway is healthy", { status: 200 });
			}

			const svc = matchService(req);
			if (svc) return forwardRequest(req, svc);

			return new Response("❌ Not Found", { status: 404 });
		},
	});

	logInfo(`🚀 Gateway listening on http://${config.host}:${config.port}`);

	process.on("SIGINT", async () => {
		logInfo("🛑 Received SIGINT. Shutting down...");
		await server.stop();
		process.exit(0);
	});

	readStdin();
}

// --- STDIN COMMAND HANDLER ---
const reader = Bun.stdin.stream().getReader();
async function readStdin() {
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			const command = new TextDecoder().decode(value).trim();

			logInfo(`📥 [STDIN] Received command: ${command}`);
			if (command === "r") {
				logInfo("🔄 Reloading configuration on command...");
				config = await loadConfig();
				logInfo("🔁 Configuration reloaded");
			} else {
				logError(`❌ Unknown command: ${command}`);
			}
		}
	} catch (err: unknown) {
		logError(`❌ Error reading stdin: ${(err as Error).message}`);
	}
}

// --- START ---
startServer().catch((err) => {
	logError(`Failed to start server: ${(err as Error).stack || err}`);
	process.exit(1);
});
