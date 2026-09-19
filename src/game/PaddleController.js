import { Vec3 } from '../../public/physics/math.js';

export class PaddleController {
	#inputs = [{ tick: 0, seq: -1, direction: new Vec3() }];
	#lastReceivedSeq = -1;
	#simulationTick = 0;

	constructor() {
		this.ack = -1;
	}

	/**
	 * Validate and reserve an input sequence number without applying it yet.
	 * ServerScene uses this to batch all network input at a tick boundary.
	 */
	acceptInput(input) {
		if (!Number.isInteger(input?.seq) || input.seq <= this.#lastReceivedSeq) {
			return null;
		}

		const direction = input.direction;
		if (
			!Array.isArray(direction) ||
			direction.length !== 3 ||
			!direction.every(Number.isFinite)
		) {
			return null;
		}

		this.#lastReceivedSeq = input.seq;
		const normalizedDirection = new Vec3(...direction);
		const magnitude = normalizedDirection.norm();
		if (magnitude > 1) normalizedDirection.scale(1 / magnitude);
		return {
			seq: input.seq,
			direction: normalizedDirection
		};
	}

	/**
	 * Insert an accepted movement state at an authoritative simulation tick.
	 * Returns true only when doing so changes simulation history.
	 */
	insertInput(input, tick) {
		if (!input || !Number.isInteger(tick)) return false;

		const previousDirection = this.getDirectionAtTick(tick);
		this.#inputs.push({
			tick,
			seq: input.seq,
			direction: input.direction.clone()
		});
		this.#inputs.sort((a, b) => a.tick - b.tick || a.seq - b.seq);
		this.ack = Math.max(this.ack, input.seq);

		return !previousDirection.approxEquals(input.direction);
	}

	enqueueInput(input, tick = this.#simulationTick) {
		const accepted = this.acceptInput(input);
		if (!accepted) return false;
		return this.insertInput(accepted, tick);
	}

	setSimulationTick(tick) {
		if (Number.isInteger(tick)) this.#simulationTick = tick;
	}

	getDirectionAtTick(tick) {
		let selected = this.#inputs[0];
		for (const input of this.#inputs) {
			if (input.tick > tick) break;
			selected = input;
		}

		return selected.direction.clone();
	}

	getDirection() {
		return this.getDirectionAtTick(this.#simulationTick);
	}

	/**
	 * Retain one baseline input plus all states inside the rollback window.
	 */
	pruneBefore(tick) {
		if (!Number.isInteger(tick)) return;

		let baseline = this.#inputs[0];
		for (const input of this.#inputs) {
			if (input.tick > tick) break;
			baseline = input;
		}

		this.#inputs = [
			{
				tick,
				seq: baseline.seq,
				direction: baseline.direction.clone()
			},
			...this.#inputs.filter((input) => input.tick > tick)
		];
	}
}
