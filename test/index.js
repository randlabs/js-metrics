const Metrics = require("../dist");
const test = require("ava");
const promclient = require("prom-client");
const axios = require("axios");

// -----------------------------------------------------------------------------

test('Basic test', async (t) => {
	try {
		const metricsServer = await Metrics.createServer({
			host: "127.0.0.1",
			port: 3001,
			accessToken: "1234",
			endpoints: {
				getHealth: "/healthcheck",
				getStats: "/metrics",
			},
			getHealthCallback: () => {
				return {
					value: 64
				};
			},
			metricsSetupCallback: (registry) => {
				const g = new promclient.Gauge({
					name: 'test_gauge',
					help: 'Example of a gauge',
					registers: [ registry ]
				});

				g.set(128);
			}
		});

		let response;
		try {
			response = await axios.get('http://127.0.0.1:3001/healthcheck');
			t.fail('Request without authorization must fail');
			return;
		}
		catch (err) {
			if (!(err && err.response && err.response.status === 403)) {
				t.fail('Expected status 403 in request without authorization');
				return;
			}
		}

		response = await axios.get('http://127.0.0.1:3001/healthcheck', {
			headers: { 'Authorization': 'Bearer 1234' }
		});
		t.assert(typeof response.data === "object" && response.data.value === 64);

		response = await axios.get('http://127.0.0.1:3001/metrics', {
			headers: { 'X-Access-Token': '1234' }
		});
		t.assert(typeof response.data === "string" && response.data.indexOf("test_gauge 128") >= 0);

		await metricsServer.shutdown();
	}
	catch (err) {
		t.fail(err.toString());
		return;
	}
	t.pass();
});
