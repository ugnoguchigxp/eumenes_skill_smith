import { writeFileSync } from "node:fs";
import { fixture, ready } from "./fixture-host.js";
const [path, phase] = process.argv.slice(2);
if (!path || !phase) throw new Error("recovery_fixture_arguments");
const f = fixture({ path, parent: phase === "accepted" });
const stop = (): never => {
	process.kill(process.pid, "SIGKILL");
	throw new Error("kill_failed");
};
if (phase === "accepted") {
	f.submit();
	stop();
}
if (phase === "reserved" || phase === "response" || phase === "transaction") {
	const reply = f.submit();
	if (phase === "reserved") {
		const row = f.ports.repository.request(f.db, reply.requestRef!)!;
		const prepared = f.write(() =>
			f.service.prepare(f.db, row.ref, row.epoch, f.auth),
		)!;
		f.write(() => f.service.reserve(f.db, prepared, "modelCalls", f.auth));
		stop();
	}
	const work = await f.run(reply.requestRef!);
	if (phase === "response") stop();
	const put = f.ports.repository.putDelivery;
	f.ports.repository.putDelivery = (tx, delivery) => {
		put(tx, delivery);
		stop();
	};
	work.settle();
	throw new Error("transaction_kill_not_reached");
}
const result = await ready(f);
const delivery = f.ports.repository.deliveries(f.db, 10)[0]!;
if (phase === "delivered")
	writeFileSync(path + ".delivery", JSON.stringify(delivery));
if (phase === "acknowledged")
	f.write(() => f.ports.repository.ackDelivery(f.db, delivery.id));
if (phase === "revoked")
	f.write(() => f.service.forget(f.db, ["message:1"], 1));
if (!["settled", "delivered", "acknowledged", "revoked"].includes(phase))
	throw new Error("unknown_recovery_phase");
if (!result.build.ref) throw new Error("missing_build");
stop();
