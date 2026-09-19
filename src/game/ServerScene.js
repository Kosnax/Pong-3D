import * as Constants from '../../public/game/constants.js';
import { Scene } from '../../public/game/common/Scene.js';
import { ArenaCommon } from '../../public/game/common/ArenaCommon.js';
import { PaddleCommon } from '../../public/game/common/PaddleCommon.js';
import { PaddleController } from './PaddleController.js';
import { GameState, Player } from '../../public/game/common/GameState.js';
import { BallServer } from './BallServer.js';
import { RollbackBuffer } from './RollbackBuffer.js';
import db from '../db/db.js';

const SYNC_INTERVAL = 5;
const RESPAWN_COUNTDOWN_MS = 3000;
const DEFAULT_ELO = 1000;
const FIXED_SIMULATION_STEP = 1 / Constants.SIMULATION_RATE;
const FIXED_SIMULATION_STEP_MS = FIXED_SIMULATION_STEP * 1000;
export const RECONNECT_GRACE_MS = 15_000;
export const FORFEIT_RESULT_DISPLAY_MS = 5_000;
export const MAX_ROLLBACK_TICKS = Math.round(0.15 * Constants.SIMULATION_RATE);
const ROLLBACK_HISTORY_STATES = MAX_ROLLBACK_TICKS + 2;

export function getRollbackTicks(rttMs) {
	if (!Number.isFinite(rttMs) || rttMs <= 0) return 0;
	return Math.min(
		Math.ceil(rttMs / 2 / FIXED_SIMULATION_STEP_MS),
		MAX_ROLLBACK_TICKS
	);
}

export default class ServerScene extends Scene {
	#scheduler = null;
	#running = false;
	#socket = null;
	#ball = null;
	#gameOver = null;
	#numLives = 7;
	#respawn = null;
	#matchStarted = false;
	#inProgress = false;
	#onGameEnd = null;
	#gameEnded = false;
	#ballSkinKey = 0;
	#servingPlayer = null;
	#serverTick = 0;
	#simulationTick = 0;
	#rollbackBarrierTick = 0;
	#history = new RollbackBuffer(ROLLBACK_HISTORY_STATES);
	#pendingInputs = [];
	#pendingGoal = null;
	#disconnectTimers = new Map();
	#disconnectedPlayerIds = new Set();
	#readyPlayerIds = new Set();
	#rematchPlayerIds = new Set();
	#onHostChanged = null;
	#onPlayerRemoved = null;
	#postGameCleanupTimer = null;
	#rollbackStats = {
		rollbacks: 0,
		replayedTicks: 0,
		maxRewindTicks: 0,
		invalidatedGoals: 0,
		cappedLatencyInputs: 0
	};

	constructor(socket, lives, onGameEnd, options = {}) {
		super(new GameState());

		this.#socket = socket;
		this.#onGameEnd = onGameEnd;
		this.hostUserId =
			options.hostUserId === undefined ? null : String(options.hostUserId);
		this.#onHostChanged = options.onHostChanged ?? null;
		this.#onPlayerRemoved = options.onPlayerRemoved ?? null;
		this.#scheduler = options.scheduler ?? null;

		// Order matters: Sync with public/main.js
		this.registerGameObject(new ArenaCommon('gameArena'));

		this.#ball = new BallServer('ball', (ball, wall) =>
			this.#queueGoalCandidate(ball, wall)
		);

		this.registerGameObject(this.#ball);

		this.registerGameObject(
			new PaddleCommon(
				'paddle1',
				new PaddleController(),
				'paddle',
				-23.5 / 2.125
			),
			new PaddleCommon(
				'paddle2',
				new PaddleController(),
				'paddle',
				23.5 / 2.125
			)
		);

		socket.on('client:connect', this.#onConnect.bind(this));
		socket.on('client:disconnect', this.#onDisconnect.bind(this));
		socket.addHandler('move', this.#recvMove.bind(this));
		socket.addHandler('start', this.#startGame.bind(this));
		socket.addHandler('ready', this.#setReady.bind(this));
		socket.addHandler('rematch', this.#setRematchReady.bind(this));

		this.#numLives = lives ?? 7;
		this.#recordHistory(this.#serverTick);
	}

	start() {
		if (this.#running) return;
		this.#running = true;
		this.#sendSync();
		this.#scheduler?.add(this);
	}

	stop() {
		this.#stopSimulation();
		for (const entry of this.#disconnectTimers.values()) {
			clearTimeout(entry.timer);
		}
		this.#disconnectTimers.clear();
		if (this.#postGameCleanupTimer) {
			clearTimeout(this.#postGameCleanupTimer);
			this.#postGameCleanupTimer = null;
		}
	}

	#stopSimulation() {
		if (!this.#running) return;
		this.#running = false;
		this.#scheduler?.remove(this);
	}

	get inProgress() {
		return this.#inProgress;
	}

	get status() {
		if (this.#inProgress) return 'in_progress';
		if (this.#gameOver) return 'finished';
		return 'waiting';
	}

	get playerCount() {
		return this.state.players.size;
	}

	hasPlayer(userId) {
		return this.state.players.has(String(userId));
	}

	setHostUserId(userId) {
		const nextHostUserId = userId === null ? null : String(userId);
		if (this.hostUserId === nextHostUserId) return;
		this.hostUserId = nextHostUserId;
		this.#onHostChanged?.(nextHostUserId);
		this.#updatePaddles();
	}

	canAcceptPlayer(userId = null) {
		if (this.#inProgress || this.#gameOver) return false;
		if (userId !== null && this.hasPlayer(userId)) return true;
		if (this.state.players.size >= 2) return false;
		if (
			this.hostUserId !== null &&
			!this.state.players.has(this.hostUserId) &&
			userId !== null &&
			String(userId) !== this.hostUserId
		) {
			return this.state.players.size === 0;
		}
		return true;
	}

	get serverTick() {
		return this.#serverTick;
	}

	get goalPending() {
		return this.#pendingGoal !== null;
	}

	get rollbackStats() {
		return { ...this.#rollbackStats };
	}

	/** Advance exactly one authoritative fixed simulation tick. */
	advanceTick() {
		if (this.#inProgress && this.#disconnectedPlayerIds.size > 0) return;
		this.#processPendingInputs();
		this.#commitPendingGoalIfReady();
		if (this.#gameEnded) return;
		this.#updateRespawnState();

		if (!this.#history.get(this.#serverTick)) {
			this.#recordHistory(this.#serverTick);
		}

		this.#simulateTick(this.#serverTick);
		this.#serverTick++;
		this.#recordHistory(this.#serverTick);
		this.#pruneInputHistory();

		if (this.#serverTick % SYNC_INTERVAL === 0) this.#sendSync();
	}

	#simulateTick(tick) {
		this.#simulationTick = tick;
		for (const player of this.state.players.values()) {
			player.paddle.controller?.setSimulationTick(tick);
		}
		super.step(FIXED_SIMULATION_STEP);
	}

	#captureState() {
		return {
			physics: this.state.physics.exportState(),
			physicsTime: this.state.physics.t,
			ballEnabled: this.#ball.enabled,
			ballSpeed: this.#ball.speed,
			ballIsTrigger: this.#ball.body.isTrigger,
			pendingGoal: this.#pendingGoal
				? {
						...this.#pendingGoal,
						position: [...this.#pendingGoal.position]
					}
				: null
		};
	}

	#restoreState(state) {
		this.state.physics.importState(state.physics);
		this.state.physics.t = state.physicsTime;
		this.#ball.enabled = state.ballEnabled;
		this.#ball.speed = state.ballSpeed;
		this.#ball.body.isTrigger = state.ballIsTrigger;
		this.#pendingGoal = state.pendingGoal
			? {
					...state.pendingGoal,
					position: [...state.pendingGoal.position]
				}
			: null;
	}

	#recordHistory(tick) {
		this.#history.set(tick, this.#captureState());
	}

	#resetRollbackHistory() {
		this.#rollbackBarrierTick = this.#serverTick;
		this.#history.clear();
		this.#recordHistory(this.#serverTick);
		for (const player of this.state.players.values()) {
			player.paddle.controller?.pruneBefore(this.#serverTick);
		}
	}

	#pruneInputHistory() {
		const oldestTick = this.#history.oldestTick;
		if (oldestTick === null) return;
		for (const player of this.state.players.values()) {
			player.paddle.controller?.pruneBefore(oldestTick);
		}
	}

	#processPendingInputs() {
		if (this.#pendingInputs.length === 0) return;

		const pendingInputs = this.#pendingInputs.splice(0);
		let earliestChangedTick = null;
		const rollbackEnabled =
			this.#inProgress &&
			this.#matchStarted &&
			!this.#respawn &&
			!this.#gameOver;

		for (const queued of pendingInputs) {
			const player = this.state.players.get(queued.userId);
			const controller = player?.paddle.controller;
			if (!controller) continue;

			let requestedRewindTicks = 0;
			if (rollbackEnabled && Number.isFinite(queued.rttMs)) {
				requestedRewindTicks = Math.ceil(
					queued.rttMs / 2 / FIXED_SIMULATION_STEP_MS
				);
			}

			if (requestedRewindTicks > MAX_ROLLBACK_TICKS) {
				this.#rollbackStats.cappedLatencyInputs++;
			}

			const rewindTicks = getRollbackTicks(queued.rttMs);
			const oldestTick = this.#history.oldestTick ?? this.#serverTick;
			const targetTick = Math.max(
				this.#rollbackBarrierTick,
				oldestTick,
				this.#serverTick - rewindTicks
			);

			const changedHistory = controller.insertInput(queued.input, targetTick);
			if (
				changedHistory &&
				targetTick < this.#serverTick &&
				(earliestChangedTick === null || targetTick < earliestChangedTick)
			) {
				earliestChangedTick = targetTick;
			}
		}

		if (earliestChangedTick !== null) {
			this.#rollbackAndReplay(earliestChangedTick);
		}
	}

	#rollbackAndReplay(fromTick) {
		const state = this.#history.get(fromTick);
		if (!state) return;

		const endTick = this.#serverTick;
		const hadPendingGoal = this.#pendingGoal !== null;
		this.#restoreState(state);
		this.#history.deleteFrom(fromTick);

		try {
			for (let tick = fromTick; tick < endTick; tick++) {
				this.#recordHistory(tick);
				this.#simulateTick(tick);
				this.#recordHistory(tick + 1);
			}
		} finally {
			this.#simulationTick = this.#serverTick;
		}

		const replayedTicks = endTick - fromTick;
		this.#rollbackStats.rollbacks++;
		this.#rollbackStats.replayedTicks += replayedTicks;
		this.#rollbackStats.maxRewindTicks = Math.max(
			this.#rollbackStats.maxRewindTicks,
			replayedTicks
		);
		if (hadPendingGoal && this.#pendingGoal === null) {
			this.#rollbackStats.invalidatedGoals++;
		}
	}

	#queueGoalCandidate(ball, wall) {
		if (this.#gameOver || this.#respawn || this.#pendingGoal || !wall?.player) {
			return;
		}

		this.#pendingGoal = {
			tick: this.#simulationTick + 1,
			scoredOn: wall.player.userId,
			position: [...ball.x]
		};
		ball.v.zero();
		ball.isTrigger = true;
	}

	#commitPendingGoalIfReady() {
		if (
			!this.#pendingGoal ||
			this.#serverTick - this.#pendingGoal.tick < MAX_ROLLBACK_TICKS
		) {
			return;
		}

		const pendingGoal = this.#pendingGoal;
		this.#pendingGoal = null;
		this.#ball.body.isTrigger = false;

		const scoredOnPlayer = this.state.players.get(pendingGoal.scoredOn);
		if (!scoredOnPlayer) {
			this.#resetRollbackHistory();
			return;
		}

		scoredOnPlayer.lives = Math.max(0, scoredOnPlayer.lives - 1);
		const scorer = [...this.state.players.values()].find(
			(player) => player !== scoredOnPlayer
		);
		if (scorer) {
			this.#socket.broadcast({
				type: 'goalScored',
				scorer: scorer.username,
				goalExplosionKey: scorer.goalExplosionKey,
				position: [...pendingGoal.position]
			});
		}

		if (scoredOnPlayer.lives > 0) {
			this.#startServe(scoredOnPlayer, false, scorer);
			return;
		}

		this.#endGame(scoredOnPlayer.userId);
	}

	#sendSync() {
		const physicsState = this.state.physics.exportState();
		const gameInfo = {};
		for (const [userId, player] of this.state.players) {
			gameInfo[userId] = { lives: player.lives };
		}
		const serverTs = Date.now();

		this.#socket.forEachClient((userId, ws) => {
			const paddleController =
				this.state.players.get(userId)?.paddle.controller;
			this.#socket.safeSend(ws, {
				type: 'sync',
				ack: paddleController?.ack ?? -1,
				active: this.#ball.enabled,
				physics: physicsState,
				gameInfo,
				gameOver: this.#gameOver,
				serverTs,
				serverTick: this.#serverTick,
				goalPending: this.#pendingGoal !== null,
				respawnEndsAt: this.#respawn?.endAt ?? null,
				respawnScorer: this.#respawn?.scorer ?? null,
				matchStarted: this.#matchStarted,
				ballSkinKey: this.#ballSkinKey
			});
		});
	}

	#onConnect(userId, profile) {
		userId = String(userId);
		const reconnectEntry = this.#disconnectTimers.get(userId);
		if (reconnectEntry) {
			clearTimeout(reconnectEntry.timer);
			this.#disconnectTimers.delete(userId);
			this.#disconnectedPlayerIds.delete(userId);
		}

		const existingPlayer = this.state.players.get(userId);
		if (existingPlayer) {
			existingPlayer.username = profile.displayName;
			existingPlayer.paddle.controller?.reset(this.#serverTick);
			this.#pendingInputs = this.#pendingInputs.filter(
				(input) => input.userId !== userId
			);
			this.#resetRollbackHistory();
			this.#socket.broadcast({ type: 'playerReconnected', userId });
			this.#updatePaddles();
			this.#sendSync();
			return;
		}

		if (!this.canAcceptPlayer(userId)) {
			this.#updatePaddles();
			this.#sendSync();
			return;
		}

		const usedPaddles = new Set(
			[...this.state.players.values()].map((player) => player.paddle.key)
		);
		const myPaddle = ['paddle1', 'paddle2']
			.map((key) => this.getGameObject(key))
			.find((paddle) => !usedPaddles.has(paddle.key));
		if (!myPaddle) return;

		const thisPlayer = new Player(
			userId,
			profile.displayName,
			myPaddle,
			DEFAULT_ELO
		);
		this.state.players.set(userId, thisPlayer);
		const arena = this.getGameObject('gameArena');
		if (myPaddle.body.x.x < 0) arena.bodies[4].player = thisPlayer;
		else arena.bodies[5].player = thisPlayer;

		if (this.hostUserId === null) {
			this.setHostUserId(userId);
		}

		this.#updatePaddles();
		this.#sendSync();
		this.#loadPlayerProfile(thisPlayer);
	}

	#onDisconnect(userId) {
		userId = String(userId);
		const player = this.state.players.get(userId);
		if (!player || this.#disconnectTimers.has(userId)) return;

		const expiresAt = Date.now() + RECONNECT_GRACE_MS;
		this.#disconnectedPlayerIds.add(userId);
		const timer = setTimeout(
			() => this.#expireDisconnectedPlayer(userId),
			RECONNECT_GRACE_MS
		);
		timer.unref?.();
		this.#disconnectTimers.set(userId, { timer, expiresAt });
		this.#readyPlayerIds.delete(userId);
		this.#rematchPlayerIds.delete(userId);
		this.#socket.broadcast({
			type: 'reconnectStatus',
			userId,
			username: player.username,
			expiresAt
		});
		this.#updatePaddles();
	}

	#expireDisconnectedPlayer(userId) {
		if (this.#socket.isConnected?.(userId)) return;
		this.#disconnectTimers.delete(userId);
		this.#disconnectedPlayerIds.delete(userId);

		if (this.#inProgress && !this.#gameEnded) {
			this.#endGame(userId, true);
			return;
		}

		this.#removePlayer(userId);
		if (this.#gameOver) this.#resetToWaiting();
	}

	#removePlayer(userId) {
		const player = this.state.players.get(userId);
		if (!player) return;
		this.state.players.delete(userId);
		this.#readyPlayerIds.delete(userId);
		this.#rematchPlayerIds.delete(userId);
		const arena = this.getGameObject('gameArena');
		for (const body of arena.bodies) {
			if (body.player === player) delete body.player;
		}

		if (userId === this.hostUserId) {
			this.setHostUserId(
				[...this.state.players.keys()].find((id) =>
					this.#socket.isConnected?.(id)
				) ??
					[...this.state.players.keys()][0] ??
					null
			);
		}
		this.#onPlayerRemoved?.(userId);
		this.#updatePaddles();
	}

	#updatePaddles() {
		this.#socket.forEachClient((thisUserId, ws) => {
			const players = [...this.state.players.entries()].map(
				([userId, player]) => {
					const paddle = player.paddle;
					return {
						userId,
						key: paddle.key,
						username: player.username,
						elo: player.elo,
						ballSkinKey: player.ballSkinKey,
						paddleSkinKey: player.paddleSkinKey,
						goalExplosionKey: player.goalExplosionKey,
						remote: thisUserId !== userId,
						connected: !this.#disconnectedPlayerIds.has(userId),
						ready: this.#readyPlayerIds.has(userId),
						rematchReady: this.#rematchPlayerIds.has(userId),
						pos: [...paddle.body.x.data]
					};
				}
			);

			this.#socket.safeSend(ws, {
				type: 'playerSync',
				// order must be the same between client and server
				players: [...players],
				hostUserId: this.hostUserId,
				userId: thisUserId
			});
		});
	}

	async #loadPlayerProfile(player) {
		try {
			const row = await new Promise((resolve, reject) => {
				db.get(
					`SELECT
						 u.elo,
						 p.item_key AS paddle_skin_key,
						 b.item_key AS ball_skin_key,
						 g.item_key AS goal_explosion_key
						 FROM users u
						 LEFT JOIN user_equipped ue ON ue.user_id = u.id
						 LEFT JOIN items p ON p.id = ue.paddle_skin_item_id
						 LEFT JOIN items b ON b.id = ue.ball_skin_item_id
						 LEFT JOIN items g ON g.id = ue.goal_explosion_item_id
						 WHERE u.id = ? LIMIT 1`,
					[Number(player.userId)],
					(err, result) => {
						if (err) reject(err);
						else resolve(result);
					}
				);
			});
			const currentPlayer = this.state.players.get(player.userId);
			if (currentPlayer !== player) return;

			const elo = Number(row?.elo);
			if (Number.isFinite(elo)) player.elo = elo;

			const paddleSkinKey = Number(row?.paddle_skin_key);
			if (Number.isFinite(paddleSkinKey)) {
				player.paddleSkinKey = paddleSkinKey;
			}

			const ballSkinKey = Number(row?.ball_skin_key);
			if (Number.isFinite(ballSkinKey)) {
				player.ballSkinKey = ballSkinKey;
				if (this.#servingPlayer === player) this.#ballSkinKey = ballSkinKey;
			}

			const goalExplosionKey = Number(row?.goal_explosion_key);
			if (Number.isFinite(goalExplosionKey)) {
				player.goalExplosionKey = goalExplosionKey;
			}

			this.#updatePaddles();
		} catch (err) {
			console.error(`Failed to load profile for ${player.username}:`, err);
		}
	}

	#startGame(socket, userId) {
		if (userId !== this.hostUserId)
			return { type: 'error', message: 'Only the host can start the game' };
		if (this.#inProgress || this.#gameEnded)
			return { type: 'error', message: 'Game is already in progress' };
		if (this.state.players.size < 2)
			return {
				type: 'error',
				message: 'Two players are required to start'
			};
		if (
			[...this.state.players.keys()].some(
				(id) => !this.#readyPlayerIds.has(id) || !this.#socket.isConnected?.(id)
			)
		) {
			return {
				type: 'error',
				message: 'Both players must be connected and ready'
			};
		}

		this.#beginMatch();
	}

	#setReady(socket, userId, ws, msg) {
		if (this.#inProgress || this.#gameOver || !this.state.players.has(userId)) {
			return {
				type: 'error',
				message: 'Readiness cannot be changed right now'
			};
		}
		if (msg.ready) this.#readyPlayerIds.add(userId);
		else this.#readyPlayerIds.delete(userId);
		this.#updatePaddles();
	}

	#setRematchReady(socket, userId, ws, msg) {
		if (!this.#gameOver || !this.state.players.has(userId)) {
			return {
				type: 'error',
				message: 'There is no completed match to replay'
			};
		}
		if (msg.ready) this.#rematchPlayerIds.add(userId);
		else this.#rematchPlayerIds.delete(userId);
		this.#updatePaddles();

		const connectedPlayerIds = [...this.state.players.keys()].filter((id) =>
			this.#socket.isConnected?.(id)
		);
		if (
			connectedPlayerIds.length === 2 &&
			connectedPlayerIds.every((id) => this.#rematchPlayerIds.has(id))
		) {
			this.#resetForRematch();
			this.#beginMatch();
		}
	}

	#beginMatch() {
		for (const entry of this.#disconnectTimers.values())
			clearTimeout(entry.timer);
		this.#disconnectTimers.clear();
		this.#disconnectedPlayerIds.clear();
		this.#readyPlayerIds.clear();
		this.#rematchPlayerIds.clear();
		this.#pendingInputs = [];

		for (const player of this.state.players.values()) {
			player.lives = this.#numLives;
			player.paddle.controller?.reset(this.#serverTick);
		}

		this.#gameOver = null;
		this.#respawn = null;
		this.#matchStarted = true;
		this.#ball.enabled = true;
		this.#inProgress = true;
		this.#gameEnded = false;

		this.#startServe(
			Array.from(this.state.players.values())[Math.floor(Math.random() * 2)],
			true
		);
		this.start();
		this.#updatePaddles();
		this.#sendSync();
	}

	#recvMove(socket, userId, ws, msg) {
		if (!this.#inProgress) return;
		const controller =
			this.state.players.get(userId)?.paddle.controller ?? null;
		const input = controller?.acceptInput(msg);
		if (!input) return;

		this.#pendingInputs.push({
			userId,
			input,
			rttMs: socket.getRttMs?.(userId) ?? null
		});
	}

	#updateRespawnState() {
		if (!this.#respawn || this.#gameOver) return;

		if (Date.now() < this.#respawn.endAt) return;

		this.#ball.serve();
		this.#ball.setServer(null);
		this.#respawn = null;
		this.#resetRollbackHistory();
	}

	#resetForRematch() {
		this.#resetMatchState();
	}

	#resetToWaiting() {
		this.#resetMatchState();
	}

	#resetMatchState() {
		if (this.#postGameCleanupTimer) {
			clearTimeout(this.#postGameCleanupTimer);
			this.#postGameCleanupTimer = null;
		}
		this.#gameOver = null;
		this.#gameEnded = false;
		this.#matchStarted = false;
		this.#inProgress = false;
		this.#pendingGoal = null;
		this.#pendingInputs = [];
		this.#respawn = null;
		this.#servingPlayer = null;
		this.#readyPlayerIds.clear();
		this.#rematchPlayerIds.clear();
		this.#ball.enabled = false;
		this.#ball.body.isTrigger = false;
		this.#ball.body.x.zero();
		this.#ball.body.v.zero();

		for (const player of this.state.players.values()) {
			player.lives = this.#numLives;
			const initialX =
				player.paddle.key === 'paddle1' ? -23.5 / 2.125 : 23.5 / 2.125;
			player.paddle.body.x.assign(initialX, 0, 0);
			player.paddle.body.v.zero();
			player.paddle.controller?.reset?.();
		}

		this.#resetRollbackHistory();
		this.#socket.broadcast({ type: 'matchReset' });
		this.#updatePaddles();
		this.#sendSync();
	}

	#endGame(loserId, removeDisconnectedLoser = false) {
		this.#gameEnded = true;
		this.#inProgress = false;
		this.#pendingGoal = null;
		this.#ball.body.isTrigger = false;

		const loserPlayer = this.state.players.get(loserId);
		const winnerPlayer = [...this.state.players.values()].find(
			(player) => player.userId !== loserId
		);
		const finalLives = Object.fromEntries(
			[...this.state.players].map(([userId, player]) => [userId, player.lives])
		);

		const gameOver = {
			loserId,
			loser: loserPlayer?.username ?? 'Player',
			winnerId: winnerPlayer?.userId ?? null,
			winner: winnerPlayer?.username ?? null,
			finalLives,
			ratings: null
		};
		this.#gameOver = gameOver;
		this.#ball.enabled = false;
		this.#resetRollbackHistory();
		this.#stopSimulation();
		this.#saveGameResult(gameOver).then((savedGameOver) => {
			// A lobby reset can happen while the database transaction is in flight.
			// Do not let an old result overwrite or rebroadcast into a newer match.
			if (this.#gameOver !== gameOver) return;
			this.#gameOver = savedGameOver;
			this.#socket.broadcast({
				type: 'gameOver',
				...savedGameOver
			});
			this.#onGameEnd?.();
			if (removeDisconnectedLoser) {
				this.#scheduleForfeitCleanup(loserId);
			}
		});
	}

	#scheduleForfeitCleanup(loserId) {
		if (this.#postGameCleanupTimer) {
			clearTimeout(this.#postGameCleanupTimer);
		}
		this.#postGameCleanupTimer = setTimeout(() => {
			this.#postGameCleanupTimer = null;
			if (this.#socket.isConnected?.(loserId)) return;
			this.#removePlayer(loserId);
			this.#resetToWaiting();
		}, FORFEIT_RESULT_DISPLAY_MS);
		this.#postGameCleanupTimer.unref?.();
	}

	async #saveGameResult(gameOver) {
		if (!gameOver?.winner || !gameOver?.loser) return gameOver;

		const winnerId = Number(gameOver.winnerId);
		const loserId = Number(gameOver.loserId);
		if (!Number.isInteger(winnerId) || !Number.isInteger(loserId)) {
			return gameOver;
		}

		try {
			const winner = await new Promise((resolve, reject) => {
				db.get('SELECT elo FROM users WHERE id = ?', [winnerId], (err, row) => {
					if (err) reject(err);
					else resolve(row);
				});
			});
			const loser = await new Promise((resolve, reject) => {
				db.get('SELECT elo FROM users WHERE id = ?', [loserId], (err, row) => {
					if (err) reject(err);
					else resolve(row);
				});
			});
			if (!winner || !loser) {
				console.warn('skipping elo/match_history update: user lookup failed');
				return gameOver;
			}

			const winnerExpected = 1 / (1 + 10 ** ((loser.elo - winner.elo) / 400));
			const loserExpected = 1 / (1 + 10 ** ((winner.elo - loser.elo) / 400));
			const winnerEloAfter = Math.round(winner.elo + 32 * (1 - winnerExpected));
			const loserEloAfter = Math.round(loser.elo + 32 * (0 - loserExpected));
			const winnerDelta = winnerEloAfter - winner.elo;
			const loserDelta = loserEloAfter - loser.elo;

			const winnerLives = gameOver.finalLives?.[String(winnerId)];
			const savedGameOver = {
				...gameOver,
				ratings: {
					[String(winnerId)]: {
						before: winner.elo,
						after: winnerEloAfter,
						change: winnerDelta
					},
					[String(loserId)]: {
						before: loser.elo,
						after: loserEloAfter,
						change: loserDelta
					}
				}
			};
			/** @type {{id: number, display_name: string, kind: string} | null} */
			let unlockedItem = null;

			await new Promise((resolve, reject) => {
				db.run('BEGIN TRANSACTION', (err) => {
					if (err) reject(err);
					else resolve();
				});
			});

			try {
				await new Promise((resolve, reject) => {
					db.run(
						'UPDATE users SET elo = ? WHERE id = ?',
						[winnerEloAfter, winnerId],
						(err) => {
							if (err) reject(err);
							else resolve();
						}
					);
				});
				await new Promise((resolve, reject) => {
					db.run(
						'UPDATE users SET elo = ? WHERE id = ?',
						[loserEloAfter, loserId],
						(err) => {
							if (err) reject(err);
							else resolve();
						}
					);
				});
				await new Promise((resolve, reject) => {
					db.run(
						`INSERT INTO match_history (
							winner_user_id,
							loser_user_id,
							winner_lives_remaining,
							winner_elo_before,
							winner_elo_after,
							loser_elo_before,
							loser_elo_after
						) VALUES (?, ?, ?, ?, ?, ?, ?)`,
						[
							winnerId,
							loserId,
							winnerLives,
							winner.elo,
							winnerEloAfter,
							loser.elo,
							loserEloAfter
						],
						(err) => {
							if (err) reject(err);
							else resolve();
						}
					);
				});
				await new Promise((resolve, reject) => {
					db.get(
						`SELECT i.id, i.display_name, i.kind FROM items i
							WHERE i.is_default = 0
							AND i.id NOT IN (SELECT item_id FROM user_unlocks WHERE user_id = ?)
							ORDER BY RANDOM() LIMIT 1`,
						[winnerId],
						(err, item) => {
							if (err) return reject(err);
							if (!item) return resolve();
							db.run(
								`INSERT INTO user_unlocks (user_id, item_id, unlocked_at) VALUES (?, ?, CURRENT_TIMESTAMP)`,
								[winnerId, item.id],
								(err2) => {
									if (err2) return reject(err2);
									unlockedItem = item;
									resolve();
								}
							);
						}
					);
				});
				await new Promise((resolve, reject) => {
					db.run('COMMIT', (err) => {
						if (err) reject(err);
						else resolve();
					});
				});

				const winnerPlayer = this.state.players.get(String(winnerId));
				const loserPlayer = this.state.players.get(String(loserId));
				if (winnerPlayer) winnerPlayer.elo = winnerEloAfter;
				if (loserPlayer) loserPlayer.elo = loserEloAfter;

				if (unlockedItem) {
					// Notify only after commit so a rolled-back unlock is never shown.
					this.#socket.safeSendToUser(String(winnerId), {
						type: 'itemUnlocked',
						itemId: unlockedItem.id,
						displayName: unlockedItem.display_name,
						kind: unlockedItem.kind
					});
				}

				return savedGameOver;
			} catch (txErr) {
				await new Promise((resolve) => {
					db.run('ROLLBACK', () => resolve());
				});
				throw txErr;
			}
		} catch (err) {
			console.error('Failed to save game:', err);
			return gameOver;
		}
	}

	#startServe(playerObj, initial = false, scorer = null) {
		this.#pendingGoal = null;
		this.#ball.body.isTrigger = false;
		this.#servingPlayer = playerObj;
		this.#ballSkinKey = Number.isFinite(playerObj.ballSkinKey)
			? playerObj.ballSkinKey
			: 0;
		this.#ball.setServer(playerObj);
		this.#respawn = {
			endAt: Date.now() + RESPAWN_COUNTDOWN_MS,
			scorer: initial ? null : (scorer?.username ?? null)
		};
		this.#resetRollbackHistory();
	}
}
