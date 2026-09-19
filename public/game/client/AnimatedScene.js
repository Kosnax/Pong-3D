import * as THREE from 'three';
import * as Constants from '../constants.js';
import { Scene } from '../common/Scene.js';
import { Paddle } from './Paddle.js';
import { KeyboardController } from '../controllers.js';
import { Arena } from './Arena.js';
import { Ball } from './Ball.js';
import { CameraController } from './CameraController.js';
import { GameState, Player } from '../common/GameState.js';
import { GoalAnimationSpawner } from '../shaders/goalAnimationSpawner.js';
import { GameObjectCustom } from '../common/GameObject.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { getSnapshotPredictionSeconds } from './prediction.js';

const FIXED_SIMULATION_STEP = 1 / Constants.SIMULATION_RATE;
const MAX_FRAME_DELTA = 0.05;

/**
 * Scene with rendering capabilities. Uses the `visual` on each game object.
 */
export class AnimatedScene extends Scene {
	#ball = null;

	constructor(socket) {
		super(new GameState());

		this.host = null;
		this.username = null;
		this.gameOver = null;
		this.respawnEndsAt = null;
		this.respawnScorer = null;
		this.matchStarted = false;
		this.goalPending = false;
		this.serverTimeOffsetMs = 0;
		this.unlockedItem = null;
		this.renderer = new THREE.WebGLRenderer();
		this.renderer.setSize(window.innerWidth, window.innerHeight);
		this.renderer.shadowMap.enabled = true;
		this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
		document.body.appendChild(this.renderer.domElement);

		this.scene = new THREE.Scene();
		this.camera = new THREE.PerspectiveCamera(
			110,
			window.innerWidth / window.innerHeight,
			0.1,
			1000
		);

		this.controls = new OrbitControls(this.camera, this.renderer.domElement);
		const cameraDistance = 14;
		this.controls.minDistance = cameraDistance;
		this.controls.maxDistance = cameraDistance;
		this.controls.enablePan = false;
		this.camera.position.set(0, 0, 0);
		this.controls.update();
		this.whichPerson = 0;

		this.filpPerson = ((e) => {
			if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;

			this.whichPerson = (this.whichPerson + 1) % 2;

			this.updateOrbitCamera();
		}).bind(this);

		window.addEventListener('keydown', this.filpPerson);

		const goalSpawner = new GoalAnimationSpawner('goalSpawner');
		this.registerGameObject(goalSpawner);

		window.addEventListener('resize', () => {
			this.camera.aspect = window.innerWidth / window.innerHeight;
			this.camera.updateProjectionMatrix();
			this.renderer.setSize(window.innerWidth, window.innerHeight);
		});

		this.camera.position.set(-16, 0, 0);
		this.camera.up.set(0, 1, 0);
		this.camera.lookAt(0, 0, 0);

		this.physicsAccumulator = 0;
		this.lastFrameTimeMs = null;
		this.animationFrameId = null;

		this._isRunning = false;
		this._hiddenHtml = new Map();

		this.isReplaying = false;

		socket.addHandler('sync', this.#sync.bind(this));
		socket.addHandler('gameOver', this.#gameOver.bind(this));
		socket.addHandler('goalScored', this.#goalScored.bind(this));
		socket.addHandler('playerSync', this.#playerSync.bind(this));
		socket.addHandler('itemUnlocked', this.#itemUnlocked.bind(this));
		socket.addHandler('gameCancelled', this.#gameCancelled.bind(this));

		// Order matters: Sync with ServerScene.js
		this.registerGameObject(new Arena('gameArena'));

		this.#ball = new Ball('ball', goalSpawner);
		this.registerGameObject(this.#ball);

		const p1 = new Paddle('paddle1', socket, 'paddle', -23.5 / 2.125, null);

		const p2 = new Paddle('paddle2', socket, 'paddle', 23.5 / 2.125, null);
		p2.visual.rotation.y = Math.PI;

		this.registerGameObject(p1, p2);

		this.registerGameObject(
			new CameraController('cameraController', null, {
				offset: new THREE.Vector3(-4, 3, 0)
			})
		);
	}

	updateOrbitCamera() {
		const degreeToRad = Math.PI / 180;

		const verticalDegreesOfFreedom = 10;
		const horizontalDegreesOfFreedom = 10;

		this.controls.minPolarAngle =
			Math.PI / 2 - horizontalDegreesOfFreedom * degreeToRad;
		this.controls.maxPolarAngle =
			Math.PI / 2 + horizontalDegreesOfFreedom * degreeToRad;

		const sign = this.whichPerson == 0 ? -1 : 1;

		this.controls.minAzimuthAngle =
			(sign * Math.PI) / 2 - verticalDegreesOfFreedom * degreeToRad;
		this.controls.maxAzimuthAngle =
			(sign * Math.PI) / 2 + verticalDegreesOfFreedom * degreeToRad;
	}

	get active() {
		return this.#ball.enabled;
	}

	registerGameObject(...objs) {
		super.registerGameObject(...objs);

		for (const obj of objs) {
			if (obj.visual) {
				this.scene.add(obj.visual);
			}
		}
	}

	deleteGameObject(key) {
		const obj = this.getGameObject(key);
		if (!obj) return false;

		if (obj.visual) {
			this.scene.remove(obj.visual);
			this.#disposeVisual(obj.visual);
		}

		return super.deleteGameObject(key);
	}

	animate(timestamp) {
		if (!this._isRunning) {
			this.renderer.clear();
			return;
		}

		const now = Number.isFinite(timestamp) ? timestamp : performance.now();
		const frameDelta = Math.max(
			0,
			this.lastFrameTimeMs === null
				? 0
				: Math.min((now - this.lastFrameTimeMs) / 1000, MAX_FRAME_DELTA)
		);
		this.lastFrameTimeMs = now;
		this.physicsAccumulator = Math.min(
			this.physicsAccumulator + frameDelta,
			MAX_FRAME_DELTA
		);

		while (this.physicsAccumulator >= FIXED_SIMULATION_STEP) {
			this.step(FIXED_SIMULATION_STEP);
			this.physicsAccumulator -= FIXED_SIMULATION_STEP;
		}

		for (const obj of this.gameObjects.values()) {
			obj.render(frameDelta, this.physicsAccumulator);
		}

		if (this.controls !== null) {
			this.controls.update();
		}

		this.renderer.render(this.scene, this.camera);
		this.animationFrameId = requestAnimationFrame((nextTimestamp) =>
			this.animate(nextTimestamp)
		);
	}

	start() {
		if (this._isRunning) return;
		this._isRunning = true;
		this._showNonThreeElements();
		this.physicsAccumulator = 0;
		this.lastFrameTimeMs = null;
		this.animationFrameId = requestAnimationFrame((timestamp) =>
			this.animate(timestamp)
		);
	}

	stop() {
		if (!this._isRunning) return;
		this._isRunning = false;
		this._hideNonThreeElements();
		this.renderer.render(this.scene, this.camera);
		if (this.animationFrameId !== null) {
			cancelAnimationFrame(this.animationFrameId);
			this.animationFrameId = null;
		}

		this.physicsAccumulator = 0;
		this.lastFrameTimeMs = null;
	}

	_hideNonThreeElements() {
		this._hiddenHtml.clear();
		for (const el of document.body.children) {
			if (el === this.renderer.domElement) continue;
			this._hiddenHtml.set(el, el.style.display);
			el.style.display = 'none';
		}
	}

	_showNonThreeElements() {
		for (const [el, display] of this._hiddenHtml.entries()) {
			el.style.display = display;
		}
		this._hiddenHtml.clear();
	}

	#disposeVisual(root) {
		root.traverse((obj) => {
			if (obj.geometry) obj.geometry.dispose();
			if (obj.material) {
				if (Array.isArray(obj.material)) {
					for (const mat of obj.material) this.#disposeMaterial(mat);
				} else {
					this.#disposeMaterial(obj.material);
				}
			}
		});
	}

	#disposeMaterial(mat) {
		for (const key in mat) {
			const value = mat[key];
			if (value && value.isTexture) value.dispose();
		}
		mat.dispose?.();
	}

	#sync(msg) {
		const renderedPaddles = new Map();
		for (const [username, player] of this.state.players) {
			if (player.paddle.visual) {
				renderedPaddles.set(username, player.paddle.visual.position.clone());
			}
		}
		const renderedBallPosition = this.#ball.visual.position.clone();

		this.state.physics.importState(msg.physics);

		this.#ball.enabled = msg.active;
		this.#ball.setServerSkin(msg.ballSkinKey);
		this.gameOver = msg.gameOver ?? null;
		this.respawnEndsAt =
			typeof msg.respawnEndsAt === 'number' ? msg.respawnEndsAt : null;
		this.respawnScorer =
			typeof msg.respawnScorer === 'string' ? msg.respawnScorer : null;
		this.matchStarted = msg.matchStarted === true;
		this.goalPending = msg.goalPending === true;
		this.#ball.body.isTrigger = this.goalPending;
		this.#updateServerTimeOffset(msg.serverTs);
		const snapshotPredictionSeconds = getSnapshotPredictionSeconds(
			msg.serverTs,
			this.serverNowMs
		);

		for (const [username, gameInfo] of Object.entries(msg.gameInfo)) {
			const player = this.state.players.get(username);
			if (!player) continue;
			player.lives = gameInfo.lives;
		}

		const player = this.state.players.get(this.username);
		const controller = player?.paddle.controller;

		if (controller) {
			const ack = Number.isInteger(msg.ack) ? msg.ack : -1;
			controller.inputBuffer = controller.inputBuffer.filter(
				(input) => input.seq > ack
			);
			controller.useInputBuffer = true;
			this.isReplaying = true;

			try {
				for (let i = 0; i < controller.inputBuffer.length; i++) {
					controller.inputBufferIdx = i;
					player.paddle.update(FIXED_SIMULATION_STEP);
					this.state.physics.integrateBody(
						player.paddle.body,
						FIXED_SIMULATION_STEP
					);
					player.paddle.constrainToBounds();
				}
			} finally {
				this.isReplaying = false;
				controller.useInputBuffer = false;
			}
		}

		this.#predictSnapshotForward(snapshotPredictionSeconds, player);

		this.#smoothRenderCorrections(renderedPaddles, renderedBallPosition);
	}

	#predictSnapshotForward(duration, localPlayer) {
		if (duration <= 0) return;

		for (const player of this.state.players.values()) {
			if (player === localPlayer) continue;
			this.state.physics.predictBody(player.paddle.body, duration);
			player.paddle.constrainToBounds();
		}

		if (!this.#ball.enabled || this.goalPending) return;

		// Ball prediction needs collisions, but collision resolution can impart a
		// tiny impulse to nominally static walls/paddles. Restore every other body
		// after retaining only the predicted ball state.
		const worldState = this.state.physics.exportState();
		const wasReplaying = this.isReplaying;
		let predictedPosition = null;
		let predictedVelocity = null;
		this.isReplaying = true;

		try {
			this.state.physics.predictBody(this.#ball.body, duration, true);
			predictedPosition = this.#ball.body.x.clone();
			predictedVelocity = this.#ball.body.v.clone();
		} finally {
			this.state.physics.importState(worldState);
			if (predictedPosition !== null && predictedVelocity !== null) {
				this.#ball.body.x.assign(...predictedPosition);
				this.#ball.body.v.assign(...predictedVelocity);
			}
			this.isReplaying = wasReplaying;
		}
	}

	#smoothRenderCorrections(renderedPaddles, renderedBallPosition) {
		for (const [username, player] of this.state.players) {
			player.paddle.smoothFromPosition(
				renderedPaddles.get(username),
				this.physicsAccumulator
			);
		}
		this.#ball.smoothFromPosition(
			renderedBallPosition,
			this.physicsAccumulator
		);
	}

	#gameOver(msg) {
		this.gameOver = msg;
		this.#ball.enabled = false;
	}

	#goalScored(msg) {
		this.#ball.triggerGoalExplosion(msg.goalExplosionKey, msg.position);
	}

	get isHost() {
		return this.host === this.username;
	}

	get enabled() {
		return this.#ball.enabled;
	}

	get serverNowMs() {
		return Date.now() + this.serverTimeOffsetMs;
	}

	#playerSync(msg) {
		this.username = msg.username;
		this.host = msg.host;

		const cameraController = this.getGameObject('cameraController');
		if (cameraController) cameraController.followTarget = null;

		this.state.players.clear();

		for (const player of msg.players) {
			const paddle = this.getGameObject(player.key);
			paddle.controller?.destroy?.();
			paddle.controller = null;

			this.state.players.set(
				player.username,
				new Player(
					player.username,
					paddle,
					player.elo,
					player.ballSkinKey,
					player.paddleSkinKey,
					player.goalExplosionKey
				)
			);
			paddle.setSkinStyle(player.paddleSkinKey);

			const socket = this.getGameObject('socket').config.socket;

			if (player.remote) {
				continue;
			}

			// TODO: this is silly
			cameraController.followTarget = paddle;
			if (this.controls !== null) {
				this.controls.dispose();
				this.controls = null;

				window.removeEventListener('keydown', this.filpPerson);
			}

			if (player.pos[0] < 0) {
				cameraController.offset = new THREE.Vector3(-4, 3, 0);
				paddle.controller = new KeyboardController(socket, undefined, 'zy', {
					touchHost: this.renderer.domElement,
					touchHorizontalSign: 1
				});
			} else {
				cameraController.offset = new THREE.Vector3(4, 3, 0);
				paddle.controller = new KeyboardController(
					socket,
					{
						left: ['KeyD', 'ArrowRight'],
						right: ['KeyA', 'ArrowLeft'],
						up: ['KeyW', 'ArrowUp'],
						down: ['KeyS', 'ArrowDown']
					},
					'zy',
					{
						touchHost: this.renderer.domElement,
						touchHorizontalSign: -1
					}
				);
			}
		}

		if (this.controls !== null) {
			this.updateOrbitCamera();
		}
	}

	#updateServerTimeOffset(serverTs) {
		if (typeof serverTs !== 'number') return;

		const socket = this.getGameObject('socket')?.config?.socket;
		const oneWayLatencyMs =
			typeof socket?.lastLatencyMs === 'number' ? socket.lastLatencyMs / 2 : 0;
		this.serverTimeOffsetMs = serverTs + oneWayLatencyMs - Date.now();
	}

	#itemUnlocked(msg) {
		this.unlockedItem = msg;
	}

	#gameCancelled(msg) {
		this.gameCancelled = true;
	}
}
