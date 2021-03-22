/* eslint-disable no-invalid-this */
import http from "http";
import * as promclient from "prom-client";
import { ClusterModule, loadCluster, Worker } from "./dynamicImport";

//------------------------------------------------------------------------------

const GET_STATS_REQUEST = "RANDLABS:METRICS:WEBSERVER:getMetricStatsRequest";
const GET_STATS_RESPONSE = "RANDLABS:METRICS:WEBSERVER:getMetricStatsResponse";

//------------------------------------------------------------------------------

type GetHealthCallbackFn = () => Promise<HealthStatus> | HealthStatus;
type MetricsSetupCallbackFn = (registry: promclient.Registry) => Promise<void> | void;

interface IStatRequest {
	healthStatus: HealthStatus;
	pending: number;
	fulfill: (err: Error|null, healthStatus?: HealthStatus) => void;
	timer: NodeJS.Timeout;
}

interface MasterRequestBinding {
	getHealthCallback: GetHealthCallbackFn;
	cluster: ClusterModule;
}

//------------------------------------------------------------------------------

export type HealthStatus = Record<string, any>;

export interface Options {
	host?: string;
	port?: number;
	accessToken?: string;
	usingClusters?: boolean;
	endpoints?: {
		getHealth?: string;
		getStats?: string;
	};
	getHealthCallback: GetHealthCallbackFn;
	metricsSetupCallback: MetricsSetupCallbackFn;
}

export interface Server {
	shutdown: () => Promise<void>;
}

//------------------------------------------------------------------------------

/**
 * This callback is called every time the "/health" endpoint is called.
 *
 * @callback GetHealthCallbackFn
 * @returns {HealthStatus} - Health status to return.
 */

/**
 * This callback is called when server is created in order to initialize Prometheus data collectors.
 *
 * @callback MetricsSetupCallbackFn
 * @param {promclient.Registry} registry - Prometheus client registry where data collectors must be added.
 */

/**
 * Create a new metrics web server.
 *
 * @param {Options} options - Initialization options.
 * @param {string} options.host - Bind address. Defaults to 127.0.0.1. Not used in cluster workers.
 * @param {number} options.port - Specifies the server port. Not used in cluster workers.
 * @param {string} options.accessToken - Protect access to endpoints with an access token. Optional. Not used in cluster workers.
 * @param {boolean} options.usingClusters - If the app runs inside a cluster environment, set this option to true.
 * @param {Object} options.endpoints - Overrides the endpoints paths. Optional. Not used in cluster workers.
 * @param {string} options.endpoints.getHealth - Overrides the "/health" url path. Optional.
 * @param {string} options.endpoints.getStats - Overrides the "/stats" url path. Optional.
 * @param {GetHealthCallbackFn} options.getHealthCallback - Callback function called when health information is required.
 * @param {MetricsSetupCallbackFn} options.metricsSetupCallback - Callback function called to initialize Prometheus metrics.
 * @returns {Server} - Running server instance.
 */
export async function createServer(options: Options): Promise<Server> {
	if (!options) {
		throw new Error("Missing options");
	}

	let cluster: ClusterModule | null = null;
	if (options.usingClusters) {
		cluster = loadCluster();
	}

	let host = "0.0.0.0";
	let port = 0;
	let accessToken: string|null = null;

	if ((!cluster) || cluster.isMaster) {
		// Master or single instance

		// Validate http server options on master
		if (options.host != null) {
			if (typeof options.host !== "string") {
				throw new Error("Invalid Server host");
			}
			if (options.host.length > 0) {
				host = options.host;
			}
		}

		if (options.port == null) {
			throw new Error("Server port not specified");
		}
		if (typeof options.port !== "number" || (options.port % 1) !== 0 || options.port < 1 || options.port > 65535) {
			throw new Error("Invalid Server port");
		}
		port = options.port;

		if (options.accessToken != null) {
			if (typeof options.accessToken !== "string") {
				throw new Error("Invalid access token");
			}
			accessToken = options.accessToken;
		}
	}

	// Validate callbacks
	if (typeof options.getHealthCallback !== "function") {
		throw new Error("Invalid get health callback");
	}
	if (typeof options.metricsSetupCallback !== "function") {
		throw new Error("Invalid metrics setup callback");
	}

	// Validate endpoints names
	let getHealthEndpoint = "/health";
	let getStatsEndpoint = "/stats";
	if (typeof options.endpoints === "object" && (!Array.isArray(options.endpoints))) {
		if (!validateEndpointName(options.endpoints.getHealth)) {
			throw new Error("Invalid get health endpoint name");
		}
		if (options.endpoints.getHealth) {
			getHealthEndpoint = options.endpoints.getHealth;
		}

		if (!validateEndpointName(options.endpoints.getStats)) {
			throw new Error("Invalid get stats endpoint name");
		}
		if (options.endpoints.getStats) {
			getStatsEndpoint = options.endpoints.getStats;
		}
	}
	else if (typeof options.endpoints != null) {
		throw new Error("Invalid endpoints");
	}

	// Initialize server internals
	let server: http.Server | undefined;
	let registry: promclient.Registry | promclient.AggregatorRegistry;
	const activeStatRequests = new Map<number, IStatRequest>();
	let nextStatRequestId = 0;
	let bindedOnMasterRequest: any;

	if (cluster) {
		if (cluster.isMaster) {
			// Create server only on master
			server = http.createServer();

			// Create an aggregator registry
			registry = new promclient.AggregatorRegistry();

			// Setup cluster listener
			setupMasterListener(cluster, activeStatRequests);
		}
		else {
			// Create a simple registry on forks
			registry = new promclient.Registry();

			// Add the new registry to the aggrator's registry list
			promclient.AggregatorRegistry.setRegistries(registry);

			// Setup worker listener
			bindedOnMasterRequest = onMasterRequest.bind({
				getHealthCallback: options.getHealthCallback,
				cluster
			});
			process.on("message", bindedOnMasterRequest);
		}
	}
	else {
		// Create standalone server
		server = http.createServer();

		// Create a simple registry
		registry = new promclient.Registry();
	}

	// Setup default metrics
	promclient.collectDefaultMetrics({
		register: registry
	});

	// Initialize custom metrics
	await Promise.resolve(options.metricsSetupCallback(registry));

	// If we didn't create a server, simply return a mock that shuts down worker message processing
	if (!server) {
		return {
			shutdown: function (): Promise<void> {
				return new Promise((resolve) => {
					// Remove worker listener
					process.off("message", bindedOnMasterRequest);

					resolve();
				});
			}
		};
	}

	// Attach request listener to our server
	server.on("request", (req: http.IncomingMessage, res: http.ServerResponse) => {
		// Only GET requests are allowed
		if (req.url && req.method === "GET") {
			// Check route
			if (req.url == getHealthEndpoint) {
				const requestId = nextStatRequestId;
				nextStatRequestId += 1;

				onHealthRequest(
					req, res, accessToken, activeStatRequests, requestId, options.getHealthCallback,
					cluster
				);
			}
			else if (req.url === getStatsEndpoint) {
				onStatsRequest(req, res, accessToken, registry, cluster != null);
			}
			else {
				// Other URLs are not accepted
				send404(res);
			}
		}
		else {
			// Other methods are not accepted
			send404(res);
		}
	});

	// Start listening
	const thisserver = server;
	await new Promise<void>((resolve, reject) => {
		thisserver.listen(port, host, () => {
			resolve();
		});

		// Hack hack to handle listening initialization errors
		thisserver.once('error', (err) => {
			reject(err);
		});
	});

	// Startup complete, return the server
	return {
		shutdown: function (): Promise<void> {
			return new Promise((resolve2) => {
				thisserver.close(() => {
					resolve2();
				});
			});
		}
	};
}

//------------------------------------------------------------------------------
// Private functions

function validateEndpointName(endpoint?: string): boolean {
	if (endpoint == null) {
		return true;
	}
	if (typeof endpoint !== "string") {
		return false;
	}
	return (/^(?:\/[a-zA-Z0-9.&&[^\]-]*)+$/ui).test(endpoint);
}

function send403(res: http.ServerResponse) {
	res.writeHead(403, "Forbidden", {
		"Content-Type": "text/plain"
	}).end();
}

function send404(res: http.ServerResponse) {
	res.writeHead(404, "Not Found", {
		"Content-Type": "text/plain"
	}).end();
}

function send500(res: http.ServerResponse) {
	res.writeHead(500, "Internal Server Error", {
		"Content-Type": "text/plain"
	}).end();
}

function disableCacheAndEnableCORS(res: http.ServerResponse) {
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type");
	res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
}

function checkAccess(req: http.IncomingMessage, accessToken: string | null): boolean {
	// If no access token was set, allow access
	if (!accessToken) {
		return true;
	}

	// Check access
	let token = req.headers["x-access-token"];
	if (typeof token !== "string" || token.length == 0) {
		token = req.headers.authorization;
		if (typeof token === "string" && token.substr(0, 7).toLowerCase() == "bearer ") {
			token = token.substr(7).trim();
		}
		else {
			return false;
		}
	}

	// Allow if token matches
	return (token == accessToken);
}

function onHealthRequest(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	accessToken: string | null,
	activeStatRequests: Map<number, IStatRequest>,
	requestId: number,
	getHealthCallback: GetHealthCallbackFn,
	cluster: ClusterModule | null,
): void {
	// Check access
	if (!checkAccess(req, accessToken)) {
		send403(res);
		return;
	}

	// Call callback
	Promise.resolve(getHealthCallback()).then((healthStatus: HealthStatus) => {
		// If we are not running inside a cluster...
		if (!cluster) {
			// ...just pass result to write the response
			return Promise.resolve(healthStatus);
		}

		// Else, ask the workers for their stats and merge
		return gatherWorkerStats(healthStatus, activeStatRequests, requestId, cluster);
	}).then((healthStatus: HealthStatus) => {
		// Write the response
		res.statusCode = 200;
		res.setHeader("Content-Type", "application/json");

		// Disable cache and enable CORS on any request
		disableCacheAndEnableCORS(res);

		// Send data
		res.write(JSON.stringify(healthStatus));
		res.end();
	}).catch(() => {
		send500(res);
	});
}

function onStatsRequest(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	accessToken: string | null,
	registry: promclient.Registry,
	useClustering?: boolean
): void {
	// Check access
	if (!checkAccess(req, accessToken)) {
		send403(res);
		return;
	}

	// Gather for metrics
	const promise = (useClustering) ? (registry as promclient.AggregatorRegistry).clusterMetrics() : registry.metrics();
	promise.then((data: string) => {
		// Disable cache and enable CORS on any request
		disableCacheAndEnableCORS(res);

		// Send data
		res.setHeader("Content-Type", registry.contentType);
		res.end(data);
	}).catch(() => {
		send500(res);
	});
}

function setupMasterListener(cluster: ClusterModule, activeStatRequests: Map<number, IStatRequest>) {
	cluster.on("message", (worker: Worker, message: any) => {
		if (message.type === GET_STATS_RESPONSE) {
			const request = activeStatRequests.get(message.requestId);
			if (!request) {
				return;
			}

			if (message.error) {
				activeStatRequests.delete(message.requestId);
				clearTimeout(request.timer);

				request.fulfill(new Error(message.error));
				return;
			}

			//merge stats
			request.healthStatus = { ...request.healthStatus, ...message.healthStatus };
			request.pending -= 1;

			if (request.pending === 0) {
				// finalize
				activeStatRequests.delete(message.requestId);
				clearTimeout(request.timer);

				request.fulfill(null, request.healthStatus);
			}
		}
	});
}

function gatherWorkerStats(
	masterHealthStatus: HealthStatus,
	activeStatRequests: Map<number, IStatRequest>,
	requestId: number,
	cluster: ClusterModule
): Promise<HealthStatus> {
	return new Promise((resolve, reject) => {
		let fulfilled = false;

		function fulfill(err: Error|null, healthStatus?: HealthStatus): void {
			if (!fulfilled) {
				fulfilled = true;
				if (!err)
					resolve(healthStatus!);
				else
					reject(err);
			}
		}

		const newRequest: IStatRequest = {
			healthStatus: masterHealthStatus,
			pending: 0,
			fulfill,
			timer: setTimeout(() => {
				activeStatRequests.delete(requestId);

				newRequest.fulfill(new Error("Operation timed out"));
			}, 5000),
		};
		activeStatRequests.set(requestId, newRequest);

		const message = {
			type: GET_STATS_REQUEST,
			requestId,
		};

		// eslint-disable-next-line guard-for-in
		for (const id in cluster.workers) {
			const worker = cluster.workers[id];
			// If the worker exits abruptly, it may still be in the workers list but not able to communicate.
			if (worker && worker.isConnected()) {
				worker.send(message);
				newRequest.pending += 1;
			}
		}

		if (newRequest.pending === 0) {
			// No workers were up
			clearTimeout(newRequest.timer);
			activeStatRequests.delete(requestId);

			process.nextTick(() => {
				fulfill(null, newRequest.healthStatus);
			});
		}
	});
}

// eslint-disable-next-line func-style
function onMasterRequest(this: MasterRequestBinding, message: any) {
	if (this.cluster.isWorker && message.type === GET_STATS_REQUEST) {
		Promise.resolve(this.getHealthCallback()).then((healthStatus: HealthStatus) => {
			process.send!({
				type: GET_STATS_RESPONSE,
				requestId: message.requestId,
				healthStatus,
			});
		}).catch((err) => {
			process.send!({
				type: GET_STATS_RESPONSE,
				requestId: message.requestId,
				error: err.toString(),
			});
		});
	}
}
