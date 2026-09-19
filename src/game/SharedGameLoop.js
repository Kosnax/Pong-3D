import * as Constants from '../../public/game/constants.js';

const FIXED_STEP_SECONDS = 1 / Constants.SIMULATION_RATE;
const FIXED_STEP_MS = FIXED_STEP_SECONDS * 1000;
const MAX_CATCHUP_STEPS = 8;

/**
 * A single lazy fixed-step scheduler shared by every online lobby. Scenes add
 * themselves only while a match is active, so an empty server has no 120 Hz
 * timer and adding lobbies does not add timers.
 */
export default class SharedGameLoop {
	#scenes = new Set();
	#interval = null;
	#lastTime = 0;
	#accumulator = 0;

	add(scene) {
		this.#scenes.add(scene);
		if (this.#interval) return;

		this.#lastTime = performance.now();
		this.#accumulator = 0;
		this.#interval = setInterval(() => this.#tick(), FIXED_STEP_MS);
		this.#interval.unref?.();
	}

	remove(scene) {
		this.#scenes.delete(scene);
		if (this.#scenes.size === 0) this.#stopTimer();
	}

	stop() {
		this.#scenes.clear();
		this.#stopTimer();
	}

	get activeSceneCount() {
		return this.#scenes.size;
	}

	#tick() {
		const now = performance.now();
		const elapsed = Math.max(0, (now - this.#lastTime) / 1000);
		this.#lastTime = now;
		this.#accumulator = Math.min(
			this.#accumulator + elapsed,
			FIXED_STEP_SECONDS * MAX_CATCHUP_STEPS
		);

		let steps = 0;
		while (
			this.#accumulator >= FIXED_STEP_SECONDS &&
			steps < MAX_CATCHUP_STEPS
		) {
			for (const scene of this.#scenes) {
				try {
					scene.advanceTick();
				} catch (error) {
					console.error('Lobby simulation failed:', error);
					try {
						scene.stop?.();
					} finally {
						this.remove(scene);
					}
				}
			}
			this.#accumulator -= FIXED_STEP_SECONDS;
			steps++;
		}
	}

	#stopTimer() {
		if (this.#interval) clearInterval(this.#interval);
		this.#interval = null;
		this.#accumulator = 0;
	}
}
