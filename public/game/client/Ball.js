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
	#trail = null;
	#trailPositions = new Float32Array(14 * 3);
	#lastTrailPoint = new THREE.Vector3();
	#trailInitialized = false;
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
			if (identifier === undefined) return;
			if (this.scene?.isReplaying || this.scene?.goalPending) return;

			if (identifier === 'paddle') {
				this.scene?.getGameObject('cameraController')?.addShake(0.12, 0.12);
				this.scene?.audio?.playHit(this.body.v.norm());
				return;
			}

			this.scene?.audio?.playWall(this.body.v.norm());
			if (identifier === 'greenWall' || identifier === 'redWall') {
				this.scene?.getGameObject('cameraController')?.addShake(0.3, 0.22);
			}
		}).bind(this);
	}

	init(scene) {
		this.scene = scene;
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute(
			'position',
			new THREE.BufferAttribute(this.#trailPositions, 3)
		);
		const material = new THREE.LineBasicMaterial({
			color: 0x9ff6ff,
			transparent: true,
			opacity: 0.48,
			depthWrite: false
		});
		this.#trail = new THREE.Line(geometry, material);
		this.#trail.frustumCulled = false;
		this.#trail.renderOrder = 2;
		scene.scene?.add(this.#trail);
	}

	update(dt) {
		super.update(dt);
		this.#skin.update(dt, this.body.v.norm());
	}

	// Visual transforms are applied once per display frame in render().
	sync(dt) {}

	render(frameDelta, extrapolation) {
		this.#bodyRenderer.render(frameDelta, extrapolation);
		this.#updateTrail();
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

	#updateTrail() {
		if (!this.#trail) return;
		this.#trail.visible = this.enabled;
		if (!this.#trail.visible) {
			this.#trailInitialized = false;
			return;
		}

		const current = this.#visual.position;
		if (
			!this.#trailInitialized ||
			current.distanceToSquared(this.#lastTrailPoint) > 16
		) {
			for (let i = 0; i < this.#trailPositions.length; i += 3) {
				this.#trailPositions[i] = current.x;
				this.#trailPositions[i + 1] = current.y;
				this.#trailPositions[i + 2] = current.z;
			}
			this.#trailInitialized = true;
		} else {
			this.#trailPositions.copyWithin(3, 0, this.#trailPositions.length - 3);
			this.#trailPositions[0] = current.x;
			this.#trailPositions[1] = current.y;
			this.#trailPositions[2] = current.z;
		}

		this.#lastTrailPoint.copy(current);
		this.#trail.geometry.attributes.position.needsUpdate = true;
	}

	kill() {
		if (this.#trail) {
			this.scene?.scene?.remove(this.#trail);
			this.#trail.geometry?.dispose?.();
			this.#trail.material?.dispose?.();
			this.#trail = null;
		}
	}

	get visual() {
		return this.#visual;
	}
}
