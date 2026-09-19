import * as Constants from '../constants.js';
import * as THREE from 'three';
import { KeyboardController } from '../controllers.js';
import { PaddleCommon } from '../common/PaddleCommon.js';
import { PADDLE_STYLE_CATALOG, PaddleSkin } from '../shaders/paddleSkin.js';

/**
 * Client-side Paddle with THREE.js rendering
 * Extends PaddleCommon to add visual representation
 */
export class Paddle extends PaddleCommon {
	#visual = null;
	#skin = null;
	#renderCorrection = new THREE.Vector3();
	#hasRenderCorrection = false;

	constructor(
		key,
		socket,
		bodyIdentifier,
		initialX,
		controller = new KeyboardController(socket)
	) {
		super(key, controller, bodyIdentifier, initialX);

		this.#skin = new PaddleSkin({
			dimensions: {
				width: Constants.PADDLE_THICKNESS,
				height: Constants.PADDLE_HEIGHT,
				depth: Constants.PADDLE_DEPTH
			}
		});
		this.#visual = this.#skin.visual;
		this.#visual.castShadow = true;
		this.#visual.receiveShadow = true;
	}

	init(scene) {
		super.init(scene);
		this.scene = scene;
	}

	update(dt) {
		super.update(dt);

		if (this.scene.isReplaying) return;
		this.#skin.update(dt, this.body.v.norm(), this.ball?.body?.x ?? null);
	}

	sync(dt) {
		if (!this.#hasRenderCorrection) {
			this.#visual.position.copy(this.body.x);
			return;
		}

		const blend = 1 - Math.exp(-dt * 18);
		this.#renderCorrection.multiplyScalar(1 - blend);
		this.#visual.position.copy(this.body.x).add(this.#renderCorrection);

		if (this.#renderCorrection.lengthSq() < 0.000001) {
			this.#renderCorrection.set(0, 0, 0);
			this.#hasRenderCorrection = false;
			this.#visual.position.copy(this.body.x);
		}
	}

	smoothFromPosition(position) {
		if (!position) return;

		this.#renderCorrection.copy(position).sub(this.body.x);
		this.#hasRenderCorrection = this.#renderCorrection.lengthSq() >= 0.000001;
		this.#visual.position.copy(position);
	}

	setSkinStyle(styleIndex) {
		return this.#skin.setStyle(styleIndex);
	}

	setSkinColor(color) {
		this.#skin.setColor(color);
	}

	resetSkinColor() {
		this.#skin.resetColor();
	}

	kill() {
		this.#skin.dispose();
	}

	get visual() {
		return this.#visual;
	}

	get styleIndex() {
		return this.#skin.styleIndex;
	}

	get styleCatalog() {
		return PADDLE_STYLE_CATALOG;
	}
}
