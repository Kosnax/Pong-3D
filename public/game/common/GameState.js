import { PhysicsEngine } from '../../physics/engine.js';

export class Player {
	constructor(
		userId,
		username,
		paddle,
		elo = 1000,
		ballSkinKey = 0,
		paddleSkinKey = 0,
		goalExplosionKey = 0
	) {
		this.userId = String(userId);
		this.username = username;
		this.lives = 7;
		this.elo = elo;
		this.ballSkinKey = ballSkinKey;
		this.paddleSkinKey = paddleSkinKey;
		this.goalExplosionKey = goalExplosionKey;
		this.paddle = paddle;
	}
}

export class GameState {
	constructor() {
		this.physics = new PhysicsEngine();
		this.players = new Map();
	}
}
