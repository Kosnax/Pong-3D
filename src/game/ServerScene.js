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
const MAX_SERVER_CATCHUP_STEPS = 8;
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
	#interval = null;
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
	#rollbackStats = {
		rollbacks: 0,
		replayedTicks: 0,
		maxRewindTicks: 0,
		invalidatedGoals: 0,
		cappedLatencyInputs: 0
	};

	constructor(socket, lives, onGameEnd) {
		super(new GameState());

		this.#socket = socket;
		this.#onGameEnd = onGameEnd;
		this.hostUser = null;

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

		this.#numLives = lives ?? 7;
		this.#recordHistory(this.#serverTick);
	}

	start() {
		if (this.#interval) return;

		let lastTime = performance.now();
		let accumulator = 0;
		this.#sendSync();

		this.#interval = setInterval(() => {
			const now = performance.now();
			const elapsed = Math.max(0, (now - lastTime) / 1000);
			accumulator = Math.min(
				accumulator + elapsed,
				FIXED_SIMULATION_STEP * MAX_SERVER_CATCHUP_STEPS
			);

			let steps = 0;
			while (
				accumulator >= FIXED_SIMULATION_STEP &&
				steps < MAX_SERVER_CATCHUP_STEPS
			) {
				this.advanceTick();
				accumulator -= FIXED_SIMULATION_STEP;
				steps++;
			}

			lastTime = now;
		}, FIXED_SIMULATION_STEP_MS);
	}

	stop() {
		if (this.#interval) clearInterval(this.#interval);
		this.#interval = null;
	}

	get inProgress() {
		return this.#inProgress;
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
		this.#processPendingInputs();
		this.#commitPendingGoalIfReady();
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
			const player = this.state.players.get(queued.username);
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
			scoredOn: wall.player.username,
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

		this.#endGame(scoredOnPlayer.username);
	}

	#sendSync() {
		const physicsState = this.state.physics.exportState();
		const gameInfo = {};
		for (const [username, player] of this.state.players) {
			gameInfo[username] = { lives: player.lives };
		}
		const serverTs = Date.now();

		this.#socket.forEachClient((username, ws) => {
			const paddleController =
				this.state.players.get(username)?.paddle.controller;
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

	#onConnect(username) {
		if (this.state.players.size >= 2) {
			this.#updatePaddles();
			return;
		}
		const pid = this.state.players.size;
		const myPaddle = this.getGameObject(`paddle${pid + 1}`);
		const thisPlayer = new Player(username, myPaddle, DEFAULT_ELO);
		this.state.players.set(username, thisPlayer);
		const arena = this.getGameObject('gameArena');

		// Hacky: Injecting the player into the bodies. Should probably see later about changing this.
		// Consequence of having to conform to the rigid map.
		if (myPaddle.body.x.x < 0) arena.bodies[4].player = thisPlayer;
		else arena.bodies[5].player = thisPlayer;

		if (this.hostUser === null) this.hostUser = username;

		this.#updatePaddles();
		this.#loadPlayerProfile(thisPlayer);
	}

	#onDisconnect(username) {
		if (this.#gameEnded) return;

		if (!this.inProgress) {
			const player = this.state.players.get(username);
			if (player) {
				this.state.players.delete(username);
				const arena = this.getGameObject('gameArena');
				for (const body of arena.bodies) {
					if (body.player === player) delete body.player;
				}
			}

			if (username === this.hostUser) {
				this.#socket.broadcast({
					type: 'gameCancelled'
				});
				this.#onGameEnd?.();
			}

			return;
		}

		if (this.state.players.has(username)) this.#endGame(username);
	}

	#updatePaddles() {
		this.#socket.forEachClient((thisUsername, ws) => {
			const players = [...this.state.players.entries()].map(
				([username, player]) => {
					const paddle = player.paddle;
					return {
						key: paddle.key,
						username: username,
						elo: player.elo,
						ballSkinKey: player.ballSkinKey,
						paddleSkinKey: player.paddleSkinKey,
						goalExplosionKey: player.goalExplosionKey,
						remote: thisUsername !== username,
						pos: [...paddle.body.x.data]
					};
				}
			);

			this.#socket.safeSend(ws, {
				type: 'playerSync',
				// order must be the same between client and server
				players: [...players],
				host: this.hostUser,
				username: thisUsername
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
						 WHERE u.display_name = ? LIMIT 1`,
					[player.username],
					(err, result) => {
						if (err) reject(err);
						else resolve(result);
					}
				);
			});
			const currentPlayer = this.state.players.get(player.username);
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

	#startGame(socket, username, ws, msg) {
		if (username !== this.hostUser)
			return { type: 'error', message: 'bruh u not the host' };
		if (this.#inProgress || this.#gameEnded)
			return { type: 'error', message: 'Game is already in progress' };
		if (this.state.players.size < 2)
			return {
				type: 'error',
				message: 'bruh we gotta wait for another person'
			};

		for (const player of this.state.players.values()) {
			player.lives = this.#numLives;
		}

		this.#gameOver = null;
		this.#respawn = null;
		this.#matchStarted = true;
		this.#ball.enabled = true;
		this.#inProgress = true;

		// ???
		this.#startServe(
			Array.from(this.state.players.values())[Math.floor(Math.random() * 2)],
			true
		);
	}

	#recvMove(socket, username, ws, msg) {
		const controller =
			this.state.players.get(username)?.paddle.controller ?? null;
		const input = controller?.acceptInput(msg);
		if (!input) return;

		this.#pendingInputs.push({
			username,
			input,
			rttMs: socket.getRttMs?.(username) ?? null
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

	#endGame(loser) {
		this.#gameEnded = true;
		this.#pendingGoal = null;
		this.#ball.body.isTrigger = false;

		const winner = [...this.state.players.values()].find(
			(player) => player.username !== loser
		)?.username;
		const finalLives = Object.fromEntries(
			[...this.state.players].map(([username, player]) => [
				username,
				player.lives
			])
		);

		this.#gameOver = { loser, winner, finalLives, ratings: null };
		this.#ball.enabled = false;
		this.#resetRollbackHistory();
		this.#saveGameResult().then(() => {
			this.#socket.broadcast({
				type: 'gameOver',
				...this.#gameOver
			});
			this.#onGameEnd?.();
		});
	}

	async #saveGameResult() {
		if (!this.#gameOver?.winner || !this.#gameOver?.loser) return;

		const winnerName = this.#gameOver.winner;
		const loserName = this.#gameOver.loser;
		const winnerId = this.#socket.getUserId(winnerName);
		const loserId = this.#socket.getUserId(loserName);

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
				return;
			}

			const winnerExpected = 1 / (1 + 10 ** ((loser.elo - winner.elo) / 400));
			const loserExpected = 1 / (1 + 10 ** ((winner.elo - loser.elo) / 400));
			const winnerEloAfter = Math.round(winner.elo + 32 * (1 - winnerExpected));
			const loserEloAfter = Math.round(loser.elo + 32 * (0 - loserExpected));
			const winnerDelta = winnerEloAfter - winner.elo;
			const loserDelta = loserEloAfter - loser.elo;

			const winnerLives = this.state.players.get(winnerName)?.lives;

			const winnerPlayer = this.state.players.get(winnerName);
			const loserPlayer = this.state.players.get(loserName);
			if (winnerPlayer) winnerPlayer.elo = winnerEloAfter;
			if (loserPlayer) loserPlayer.elo = loserEloAfter;

			this.#gameOver = {
				...this.#gameOver,
				ratings: {
					[winnerName]: {
						before: winner.elo,
						after: winnerEloAfter,
						change: winnerDelta
					},
					[loserName]: {
						before: loser.elo,
						after: loserEloAfter,
						change: loserDelta
					}
				}
			};

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
									// Tell only the winner what they unlocked.
									this.#socket.safeSendToUser(winnerName, {
										type: 'itemUnlocked',
										itemId: item.id,
										displayName: item.display_name,
										kind: item.kind
									});
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
			} catch (txErr) {
				await new Promise((resolve) => {
					db.run('ROLLBACK', () => resolve());
				});
				throw txErr;
			}
		} catch (err) {
			console.error('Failed to save game:', err);
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
