# js-metrics

Metrics is a lightweight web server that provides health status and Prometheus-compatible reports.

## Installation

```shell
npm install --save @randlabs/js-metrics
```

## Usage

```javascript
const Metrics = require("@randlabs/js-metrics");

const metricsServer = await Metrics.createServer(options);
```

### Example
```javascript
const Metrics = require("@randlabs/js-metrics");
 
const metricsServer = await Metrics.createServer({
	host: "127.0.0.1",
	port: 3001,
	accessToken: "1234",
	endpoints: {
		getHealth: "/health",
		getStats: "/metrics",
	},
	getHealthCallback: () => {
		return {
			value: Math.random() * 100
		};
	},
	metricsSetupCallback: (registry) => {
		const g = new promclient.Gauge({
			name: 'test_gauge',
			help: 'Example of a gauge',
			registers: [ registry ]
		});

		g.set(Math.random() * 100);
	}
});

// do other stuff

await metricsServer.shutdown();
```

Create a new metrics web server with the given `options`.

*   `options` - Initialization options.
*   `options.host` - Bind address. Defaults to 127.0.0.1. Not used in cluster workers.
*   `options.port` - Specifies the server port. Not used in cluster workers.
*   `options.accessToken` - Protect access to endpoints with an access token. Optional. Not used in cluster workers.
*   `options.usingClusters` - If the app runs inside a cluster environment, set this option to true.
*   `options.endpoints` - Overrides the endpoints paths. Optional. Not used in cluster workers.
*   `options.endpoints.getHealth` - Overrides the "/health" url path. Optional.
*   `options.endpoints.getStats` - Overrides the "/stats" url path. Optional.
*   `options.getHealthCallback` - Callback function called when health information is required. It must return a `HealthStatus` object.
*   `options.metricsSetupCallback` - Callback function called to initialize Prometheus metrics. It receives a `registry` objects where collectors must be added.

# License

Apache 2.0
