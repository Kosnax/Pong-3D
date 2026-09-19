import * as THREE from 'three';
import { AnimatedScene } from './game/client/AnimatedScene.js';
import { GameObjectCustom } from './game/common/GameObject.js';
import { PracticeAIController } from './game/ai.js';
import { GameAudio } from './game/audio.js';
import * as Constants from './game/constants.js';

class LocalPracticeSocket {
	constructor() {
		this.handlers = new Map();
		this.lastLatencyMs = 0;
	}

	addHandler(type, handler) {
		this.handlers.set(type, handler);
	}

	emit(type, message) {
		this.handlers.get(type)?.({ type, ...message });
	}

	send() {
		// Local prediction directly drives the practice paddle.
	}
}

function getStoredBoolean(key, fallback = false) {
	try {
		const value = localStorage.getItem(key);
		return value === null ? fallback : value === 'true';
	} catch {
		return fallback;
	}
}

function storeBoolean(key, value) {
	try {
		localStorage.setItem(key, String(Boolean(value)));
	} catch {
		// Practice still works without persisted preferences.
	}
}

const socket = new LocalPracticeSocket();
const scene = new AnimatedScene(socket);
const prefersReducedMotion = window.matchMedia?.(
	'(prefers-reduced-motion: reduce)'
)?.matches;
scene.reducedEffects = getStoredBoolean(
	'pongReducedEffects',
	prefersReducedMotion
);
scene.audio = new GameAudio({ muted: getStoredBoolean('pongMuted', false) });

scene.registerGameObject(
	new GameObjectCustom('socket', { socket }),
	new GameObjectCustom('ambientLight', {
		visual: new THREE.AmbientLight(0xffffff, 0.24)
	}),
	new GameObjectCustom('light1', {
		visual: new THREE.PointLight(0xffffff, 1000, 100),
		init() {
			this.visual.position.set(0, 0, 0);
			this.visual.castShadow = true;
		}
	}),
	new GameObjectCustom('light2', {
		visual: new THREE.PointLight(0xffffff, 850, 100),
		init() {
			this.visual.position.set(-8, 0, 0);
		}
	}),
	new GameObjectCustom('light3', {
		visual: new THREE.PointLight(0xffffff, 850, 100),
		init() {
			this.visual.position.set(8, 0, 0);
		}
	})
);

socket.emit('playerSync', {
	userId: 'practice-you',
	hostUserId: 'practice-you',
	players: [
		{
			userId: 'practice-you',
			key: 'paddle1',
			username: 'You',
			elo: 1000,
			ballSkinKey: 0,
			paddleSkinKey: 0,
			goalExplosionKey: 0,
			remote: false,
			pos: [-23.5 / 2.125, 0, 0]
		},
		{
			userId: 'practice-bot',
			key: 'paddle2',
			username: 'Pong Bot',
			elo: 1000,
			ballSkinKey: 2,
			paddleSkinKey: 2,
			goalExplosionKey: 0,
			remote: true,
			pos: [23.5 / 2.125, 0, 0]
		}
	]
});

const ball = scene.getGameObject('ball');
const you = scene.state.players.get('practice-you');
const bot = scene.state.players.get('practice-bot');
you.lives = 3;
bot.lives = 3;
bot.paddle.controller = new PracticeAIController(bot.paddle, ball);

const score = document.getElementById('practice-score');
const message = document.getElementById('practice-message');
const startOverlay = document.getElementById('practice-start');
const gameOverOverlay = document.getElementById('practice-over');
const gameOverTitle = document.getElementById('practice-over-title');
const gameOverSummary = document.getElementById('practice-over-summary');
const muteSetting = document.getElementById('practice-mute');
const reduceMotionSetting = document.getElementById('practice-reduce-motion');

muteSetting.checked = scene.audio.muted;
reduceMotionSetting.checked = scene.reducedEffects;

const match = {
	started: false,
	ended: false,
	phase: 'idle',
	servingPlayer: you,
	countdownEndsAt: 0,
	lastCountdown: null
};

function updateScore() {
	score.textContent = `You ${you.lives} — ${bot.lives} Pong Bot`;
}

function beginServe(player, seconds = 3) {
	match.phase = 'countdown';
	match.servingPlayer = player;
	match.countdownEndsAt = performance.now() + seconds * 1000;
	match.lastCountdown = null;
	ball.enabled = true;
	ball.body.isTrigger = true;
	ball.body.v.zero();
}

function finishServe() {
	const paddle = match.servingPlayer.paddle;
	const direction = paddle.body.x.x < 0 ? 1 : -1;
	const lateralY =
		Math.abs(paddle.body.v.y) > 0.15
			? paddle.body.v.y * 0.7
			: (Math.random() - 0.5) * 1.8;
	const lateralZ =
		Math.abs(paddle.body.v.z) > 0.15
			? paddle.body.v.z * 0.7
			: (Math.random() - 0.5) * 1.8;
	ball.body.isTrigger = false;
	ball.body.v
		.assign(
			(direction * Constants.BALL_INITIAL_SPEED) / 1.5,
			lateralY,
			lateralZ
		)
		.normalize()
		.scale(Constants.BALL_INITIAL_SPEED);
	match.phase = 'rally';
	message.style.display = 'none';
}

function endMatch(winner) {
	match.ended = true;
	match.phase = 'ended';
	ball.enabled = false;
	message.style.display = 'none';
	gameOverTitle.textContent = winner === you ? 'You won!' : 'Pong Bot won';
	gameOverSummary.textContent = `Final lives: You ${you.lives} — ${bot.lives} Pong Bot`;
	gameOverOverlay.classList.add('is-open');
	scene.audio.playGameOver(winner === you);
}

function scoreGoal(scoredOn) {
	if (!match.started || match.ended || match.phase !== 'rally') return;
	const scorer = scoredOn === you ? bot : you;
	scoredOn.lives = Math.max(0, scoredOn.lives - 1);
	updateScore();
	scene.audio.playGoal();

	if (scoredOn.lives === 0) {
		endMatch(scorer);
		return;
	}

	message.style.display = '';
	message.textContent = `${scorer.username} scored!`;
	beginServe(scoredOn, 2.5);
}

const originalBallCollision = ball.body.col.onCollisionCallback;
ball.body.col.onCollisionCallback = (me, other) => {
	originalBallCollision?.(me, other);
	if (other.ballIdentifier === 'greenWall') scoreGoal(you);
	if (other.ballIdentifier === 'redWall') scoreGoal(bot);
};

scene.registerGameObject(
	new GameObjectCustom('practiceMatch', {
		update() {
			if (!match.started || match.ended || match.phase !== 'countdown') return;

			const paddle = match.servingPlayer.paddle;
			const direction = paddle.body.x.x < 0 ? 1 : -1;
			ball.body.x.assign(
				paddle.body.x.x + direction * 0.9,
				paddle.body.x.y,
				paddle.body.x.z
			);
			ball.body.v.assign(0, paddle.body.v.y, paddle.body.v.z);

			const remaining = Math.max(
				0,
				Math.ceil((match.countdownEndsAt - performance.now()) / 1000)
			);
			if (remaining > 0) {
				message.style.display = '';
				message.textContent = `${match.servingPlayer.username} serves in ${remaining}`;
				if (remaining !== match.lastCountdown) {
					scene.audio.playCountdown(remaining);
					match.lastCountdown = remaining;
				}
				return;
			}

			finishServe();
		}
	})
);

function startMatch() {
	scene.audio.unlock();
	you.lives = 3;
	bot.lives = 3;
	you.paddle.body.x.assign(-23.5 / 2.125, 0, 0);
	bot.paddle.body.x.assign(23.5 / 2.125, 0, 0);
	you.paddle.body.v.zero();
	bot.paddle.body.v.zero();
	match.started = true;
	match.ended = false;
	scene.matchStarted = true;
	startOverlay.classList.remove('is-open');
	gameOverOverlay.classList.remove('is-open');
	updateScore();
	beginServe(you);
}

document
	.getElementById('practice-start-button')
	.addEventListener('click', startMatch);
document
	.getElementById('practice-rematch')
	.addEventListener('click', startMatch);

muteSetting.addEventListener('change', () => {
	scene.audio.setMuted(muteSetting.checked);
	storeBoolean('pongMuted', muteSetting.checked);
});

reduceMotionSetting.addEventListener('change', () => {
	scene.reducedEffects = reduceMotionSetting.checked;
	storeBoolean('pongReducedEffects', reduceMotionSetting.checked);
});

updateScore();
ball.enabled = false;
scene.start();
