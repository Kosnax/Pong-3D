import { Vec3 } from '../../public/physics/math.js';

export class PaddleController {
	#direction = new Vec3();
	#pendingInput = null;
	#lastReceivedSeq = -1;

	constructor() {
		this.ack = -1;
	}

	enqueueInput(input) {
		if (!Number.isInteger(input?.seq) || input.seq <= this.#lastReceivedSeq) {
			return;
		}

		const direction = input.direction;
		if (
			!Array.isArray(direction) ||
			direction.length !== 3 ||
			!direction.every(Number.isFinite)
		) {
			return;
		}

		// Movement input is a state, not an event. Keep the newest packet and
		// continue using its direction until a newer packet arrives.
		this.#lastReceivedSeq = input.seq;
		this.#pendingInput = {
			seq: input.seq,
			direction: new Vec3(...direction)
		};
	}

	getDirection() {
		if (this.#pendingInput) {
			this.#direction = this.#pendingInput.direction;
			this.ack = this.#pendingInput.seq;
			this.#pendingInput = null;
		}

		return this.#direction.clone();
	}
}
