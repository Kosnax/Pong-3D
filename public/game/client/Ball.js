import * as THREE from 'three';
import { BallCommon } from '../common/BallCommon.js';
import { BallSkin } from '../shaders/ballSkin.js';
import { SmoothBodyRenderer } from './SmoothBodyRenderer.js';

/**
 * Client-side Ball with THREE.js rendering
 * Extends BallCommon to add visual representation
 */
export class Ball extends BallCommon {
	#visual = null;
	#skin = null;
	#goalSpawner = null;
	#bodyRenderer = null;
	scene = null;

	constructor(key, spawner) {
		super(key);

		this.#skin = new BallSkin();
		this.#visual = this.#skin.visual;
		this.#goalSpawner = spawner;
		this.#bodyRenderer = new SmoothBodyRenderer(this.#visual, this.body, {
			snapDistance: 6
		});

		this.body.col.onCollisionCallback = ((me, other) => {
			const identifier = other.ballIdentifier;
			if (
				identifier === undefined ||
				(identifier !== 'greenWall' && identifier !== 'redWall')
			)
				return;
			if (this.scene?.isReplaying) return;

			this.scene?.getGameObject('cameraController')?.addShake(0.5, 1000);
		}).bind(this);
	}

	init(scene) {
		this.scene = scene;
	}

	update(dt) {
		super.update(dt);
		this.#skin.update(dt, this.body.v.norm());
	}

	// Visual transforms are applied once per display frame in render().
	sync(dt) {}

	render(frameDelta, extrapolation) {
		this.#bodyRenderer.render(frameDelta, extrapolation);
	}

	smoothFromPosition(position, extrapolation = 0) {
		this.#bodyRenderer.preserveRenderedPosition(position, extrapolation);
	}

	setSkinStyle(styleIndex) {
		return this.#skin.setStyle(styleIndex);
	}

	setServerSkin(styleIndex) {
		const numericStyleIndex = Number(styleIndex);
		if (!Number.isFinite(numericStyleIndex)) return;
		if (this.#skin.styleIndex === numericStyleIndex) return;
		this.setSkinStyle(numericStyleIndex);
	}

	triggerGoalExplosion(styleIndex, position) {
		const numericStyleIndex = Number(styleIndex);
		if (!Number.isFinite(numericStyleIndex)) return;

		this.#goalSpawner.triggerGoalAnimation(
			numericStyleIndex,
			null,
			new THREE.Vector3(
				position?.[0] ?? 0,
				position?.[1] ?? 0,
				position?.[2] ?? 0
			)
		);
	}

	get visual() {
		return this.#visual;
	}
}
