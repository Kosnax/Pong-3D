import * as THREE from 'three';
import { BallCommon } from '../common/BallCommon.js';
import { BallSkin } from '../shaders/ballSkin.js';

/**
 * Client-side Ball with THREE.js rendering
 * Extends BallCommon to add visual representation
 */
export class Ball extends BallCommon {
	#visual = null;
	#skin = null;
	#goalSpawner = null;
	#explosionId = null;
	scene = null;

	constructor(key, spawner) {
		super(key);

		this.#skin = new BallSkin();
		this.#visual = this.#skin.visual;
		this.#goalSpawner = spawner;

		this.body.col.onCollisionCallback = ((me, other) => {
			const identifier = other.ballIdentifier;
			if (
				identifier === undefined ||
				(identifier !== 'greenWall' && identifier !== 'redWall')
			)
				return;
			if (this.scene?.isReplaying) return;

			const pos = me.x;
			if (this.#explosionId !== null) {
				this.#goalSpawner.triggerGoalAnimation(
					this.#explosionId,
					null,
					new THREE.Vector3(pos.x, pos.y, pos.z)
				);
			}

			this.scene?.getGameObject('cameraController')?.addShake(0.5, 1000);
		}).bind(this);

		this.#loadEquipped();
	}

	init(scene) {
		this.scene = scene;
	}

	async #loadEquipped() {
		try {
			const response = await fetch('/user/items/equipped', {
				method: 'GET',
				credentials: 'same-origin'
			});

			if (!response.ok) throw new Error();

			const data = await response.json();
			if (data.goal_explosion_key) {
				this.#explosionId = parseInt(data.goal_explosion_key, 10);
			}
		} catch (err) {
			console.error('Failed to load: ', err);
		}
	}

	update(dt) {
		super.update(dt);
		this.#skin.update(dt, this.body.v.norm());
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

	get visual() {
		return this.#visual;
	}
}
