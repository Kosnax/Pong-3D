import * as THREE from 'three';

/**
 * Keeps a rendered object continuous while its authoritative physics body is
 * corrected by network snapshots. The body remains authoritative; only the
 * visual correction is eased out.
 */
export class SmoothBodyRenderer {
	#visual;
	#body;
	#correction = new THREE.Vector3();
	#target = new THREE.Vector3();
	#correctionRate;
	#snapDistanceSq;

	constructor(
		visual,
		body,
		{ correctionRate = 12, snapDistance = Infinity } = {}
	) {
		this.#visual = visual;
		this.#body = body;
		this.#correctionRate = correctionRate;
		this.#snapDistanceSq = snapDistance * snapDistance;
	}

	#getTarget(extrapolationSeconds) {
		const lead = Number.isFinite(extrapolationSeconds)
			? Math.max(0, extrapolationSeconds)
			: 0;

		this.#target
			.set(this.#body.x.x, this.#body.x.y, this.#body.x.z)
			.addScaledVector(this.#body.v, lead);
		return this.#target;
	}

	preserveRenderedPosition(position, extrapolationSeconds = 0) {
		if (!position) return;

		const target = this.#getTarget(extrapolationSeconds);
		this.#correction.copy(position).sub(target);

		if (this.#correction.lengthSq() > this.#snapDistanceSq) {
			this.#correction.set(0, 0, 0);
		}

		this.#visual.position.copy(target).add(this.#correction);
	}

	render(frameDelta, extrapolationSeconds = 0) {
		const dt = Number.isFinite(frameDelta) ? Math.max(0, frameDelta) : 0;
		const decay = Math.exp(-this.#correctionRate * dt);
		this.#correction.multiplyScalar(decay);

		this.#visual.position
			.copy(this.#getTarget(extrapolationSeconds))
			.add(this.#correction);
	}
}
