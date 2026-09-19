let RigidBody;
let BoxCollider;
let PhysicsEngine;

beforeAll(async () => {
	({ RigidBody, PhysicsEngine } = await import('./engine.js'));
	({ BoxCollider } = await import('./collider.js'));
});

describe('collision end-to-end test', () => {
	test('four boxes, three collisions', () => {
		const engine = new PhysicsEngine();
		const bodies = new Map();
		const collisionPairs = new Set();

		const makeBox = (key, x) => {
			const body = new RigidBody(5);
			bodies.set(body, key);
			body.col = new BoxCollider(1, 1, 1, body.transform, (me, other) => {
				collisionPairs.add(
					[bodies.get(me), bodies.get(other)].sort().join(':')
				);
			});
			body.x.assign(x, 0, 0);
			engine.registerBody(key, body);
		};

		makeBox('box1', 0);
		makeBox('box2', 0.5);
		makeBox('box3', 3);
		makeBox('box4', -3);

		engine.checkColliders();

		expect([...collisionPairs]).toEqual(['box1:box2']);
	});
});
