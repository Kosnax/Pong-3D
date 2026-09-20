import * as Constants from '../constants.js';
import { PracticeAIController } from '../ai.js';

const PRACTICE_LIVES = 3;
const GOAL_PAUSE_MS = 750;
const ROUND_PAUSE_MS = 1_500;

/**
 * Runs a client-only rally while the local user is the lobby's sole player.
 * The server remains authoritative for the real lobby; this state is discarded
 * as soon as another real player appears.
 */
export class WaitingPractice {
	#scene;
	#ball;
	#localPlayer = null;
	#botPaddle = null;
	#botController = null;
	#originalBallCollision = null;
	#practiceBallCollision = null;
	#phase = 'idle';
	#resumeAt = 0;
	#servingPaddle = null;
	#roundEnded = false;

	constructor(scene) {
		this.#scene = scene;
		this.#ball = scene.getGameObject('ball');
		this.active = false;
		this.localLives = PRACTICE_LIVES;
		this.botLives = PRACTICE_LIVES;
	}

	get scoreText() {
		const localName = this.#localPlayer?.username ?? 'You';
		return `${localName} ${this.localLives} — ${this.botLives} Pong Bot`;
	}

	update() {
		const localPlayer = this.#scene.state.players.get(this.#scene.userId);
		const shouldPractice =
			Boolean(localPlayer) &&
			this.#scene.state.players.size === 1 &&
			this.#scene.matchStarted !== true &&
			this.#scene.gameOver === null;

		if (
			shouldPractice &&
			this.active &&
			(this.#localPlayer !== localPlayer ||
				this.#botPaddle?.controller !== this.#botController)
		) {
			this.stop();
		}
		if (shouldPractice && !this.active) this.#start(localPlayer);
		if (!shouldPractice && this.active) this.stop();
		if (!this.active || this.#phase !== 'paused') return;
		if (performance.now() < this.#resumeAt) return;

		if (this.#roundEnded) {
			this.localLives = PRACTICE_LIVES;
			this.botLives = PRACTICE_LIVES;
			this.#roundEnded = false;
		}
		this.#serve(this.#servingPaddle);
	}

	stop() {
		if (!this.active) return;
		this.active = false;
		this.#phase = 'idle';

		if (
			this.#ball.body.col.onCollisionCallback === this.#practiceBallCollision
		) {
			this.#ball.body.col.onCollisionCallback = this.#originalBallCollision;
		}
		if (this.#botPaddle?.controller === this.#botController) {
			this.#botController.destroy?.();
			this.#botPaddle.controller = null;
		}

		this.#ball.enabled = false;
		this.#ball.body.isTrigger = false;
		this.#ball.body.x.zero();
		this.#ball.body.v.zero();
		this.#botPaddle?.body.v.zero();
		this.#localPlayer?.paddle.body.v.zero();
		this.#localPlayer = null;
		this.#botPaddle = null;
		this.#botController = null;
		this.#originalBallCollision = null;
		this.#practiceBallCollision = null;
	}

	#start(localPlayer) {
		const localPaddle = localPlayer.paddle;
		const botPaddle = ['paddle1', 'paddle2']
			.map((key) => this.#scene.getGameObject(key))
			.find((paddle) => paddle !== localPaddle);
		if (!botPaddle || !this.#ball) return;

		this.active = true;
		this.#localPlayer = localPlayer;
		this.#botPaddle = botPaddle;
		this.localLives = PRACTICE_LIVES;
		this.botLives = PRACTICE_LIVES;
		this.#roundEnded = false;

		botPaddle.controller?.destroy?.();
		this.#botController = new PracticeAIController(botPaddle, this.#ball);
		botPaddle.controller = this.#botController;
		botPaddle.setSkinStyle?.(2);
		this.#ball.setServerSkin?.(localPlayer.ballSkinKey);

		localPaddle.body.x.y = 0;
		localPaddle.body.x.z = 0;
		localPaddle.body.v.zero();
		botPaddle.body.x.y = 0;
		botPaddle.body.x.z = 0;
		botPaddle.body.v.zero();

		this.#originalBallCollision = this.#ball.body.col.onCollisionCallback;
		this.#practiceBallCollision = (me, other) => {
			this.#originalBallCollision?.(me, other);
			this.#handleGoalCollision(other);
		};
		this.#ball.body.col.onCollisionCallback = this.#practiceBallCollision;
		this.#serve(localPaddle);
	}

	#handleGoalCollision(other) {
		if (!this.active || this.#phase !== 'rally') return;
		const identifier = other?.ballIdentifier;
		if (identifier !== 'greenWall' && identifier !== 'redWall') return;

		const localIsLeft = this.#localPlayer.paddle.body.x.x < 0;
		const localScoredOn =
			(identifier === 'greenWall' && localIsLeft) ||
			(identifier === 'redWall' && !localIsLeft);
		if (localScoredOn) this.localLives = Math.max(0, this.localLives - 1);
		else this.botLives = Math.max(0, this.botLives - 1);

		const scorerGoalExplosionKey = localScoredOn
			? 0
			: this.#localPlayer.goalExplosionKey;
		this.#ball.triggerGoalExplosion?.(scorerGoalExplosionKey, [
			...this.#ball.body.x
		]);
		this.#scene.audio?.playGoal();

		this.#phase = 'paused';
		this.#servingPaddle = localScoredOn
			? this.#localPlayer.paddle
			: this.#botPaddle;
		this.#roundEnded = this.localLives === 0 || this.botLives === 0;
		this.#resumeAt =
			performance.now() + (this.#roundEnded ? ROUND_PAUSE_MS : GOAL_PAUSE_MS);
		this.#ball.enabled = false;
		this.#ball.body.isTrigger = true;
		this.#ball.body.v.zero();
	}

	#serve(paddle) {
		if (!paddle) return;
		const direction = paddle.body.x.x < 0 ? 1 : -1;
		this.#ball.enabled = true;
		this.#ball.body.isTrigger = false;
		this.#ball.body.x.assign(
			paddle.body.x.x + direction * 0.9,
			paddle.body.x.y,
			paddle.body.x.z
		);
		this.#ball.body.v
			.assign(
				direction,
				(Math.random() - 0.5) * 0.25,
				(Math.random() - 0.5) * 0.25
			)
			.normalize()
			.scale(Constants.BALL_INITIAL_SPEED);
		this.#phase = 'rally';
	}
}
