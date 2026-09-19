/**
 * Small tick-indexed state ring used by the authoritative server simulation.
 */
export class RollbackBuffer {
	#capacity;
	#states = new Map();

	constructor(capacity) {
		if (!Number.isInteger(capacity) || capacity < 1) {
			throw new Error('RollbackBuffer capacity must be a positive integer');
		}
		this.#capacity = capacity;
	}

	set(tick, state) {
		this.#states.set(tick, state);
		while (this.#states.size > this.#capacity) {
			this.#states.delete(this.oldestTick);
		}
	}

	get(tick) {
		return this.#states.get(tick);
	}

	deleteFrom(tick) {
		for (const storedTick of this.#states.keys()) {
			if (storedTick >= tick) this.#states.delete(storedTick);
		}
	}

	clear() {
		this.#states.clear();
	}

	get oldestTick() {
		let oldest = Infinity;
		for (const tick of this.#states.keys()) oldest = Math.min(oldest, tick);
		return oldest === Infinity ? null : oldest;
	}
}
