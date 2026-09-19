export const MAX_CHAT_LENGTH = 280;

const allowedKeysByType = {
	ping: new Set(['type', 'clientTs']),
	chat: new Set(['type', 'content']),
	move: new Set(['type', 'seq', 'direction']),
	start: new Set(['type']),
	ready: new Set(['type', 'ready']),
	rematch: new Set(['type', 'ready'])
};

function isPlainObject(value) {
	return (
		value !== null &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		(Object.getPrototypeOf(value) === Object.prototype ||
			Object.getPrototypeOf(value) === null)
	);
}

function hasOnlyAllowedKeys(message, allowedKeys) {
	return Object.keys(message).every((key) => allowedKeys.has(key));
}

function invalid(message) {
	return { ok: false, error: message };
}

/**
 * Validate and normalize every message accepted from a browser client.
 * Unknown properties are rejected so protocol changes remain deliberate.
 */
export function validateClientMessage(value) {
	if (!isPlainObject(value)) return invalid('Message must be a JSON object');
	if (typeof value.type !== 'string' || value.type.length > 32) {
		return invalid('Invalid message type');
	}

	const allowedKeys = allowedKeysByType[value.type];
	if (!allowedKeys) return invalid(`Unknown message type: ${value.type}`);
	if (!hasOnlyAllowedKeys(value, allowedKeys)) {
		return invalid(`Unexpected field in ${value.type} message`);
	}

	switch (value.type) {
		case 'ping':
			if (!Number.isFinite(value.clientTs) || value.clientTs < 0) {
				return invalid('Invalid ping timestamp');
			}
			return { ok: true, message: { type: 'ping', clientTs: value.clientTs } };

		case 'chat': {
			if (typeof value.content !== 'string') {
				return invalid('Chat content must be text');
			}
			const content = value.content.trim();
			if (content.length === 0 || content.length > MAX_CHAT_LENGTH) {
				return invalid(`Chat messages must be 1-${MAX_CHAT_LENGTH} characters`);
			}
			return { ok: true, message: { type: 'chat', content } };
		}

		case 'move': {
			if (
				!Number.isSafeInteger(value.seq) ||
				value.seq < 0 ||
				!Array.isArray(value.direction) ||
				value.direction.length !== 3 ||
				!value.direction.every(
					(component) => Number.isFinite(component) && Math.abs(component) <= 1
				)
			) {
				return invalid('Invalid movement input');
			}
			return {
				ok: true,
				message: {
					type: 'move',
					seq: value.seq,
					direction: [...value.direction]
				}
			};
		}

		case 'start':
			return { ok: true, message: { type: 'start' } };

		case 'ready':
		case 'rematch':
			if (typeof value.ready !== 'boolean') {
				return invalid(`${value.type} state must be a boolean`);
			}
			return {
				ok: true,
				message: { type: value.type, ready: value.ready }
			};
	}

	return invalid('Unsupported message type');
}

export const MESSAGE_RATE_LIMITS = Object.freeze({
	ping: { limit: 12, windowMs: 10_000 },
	chat: { limit: 5, windowMs: 5_000 },
	move: { limit: 300, windowMs: 4_000 },
	start: { limit: 5, windowMs: 10_000 },
	ready: { limit: 10, windowMs: 10_000 },
	rematch: { limit: 10, windowMs: 10_000 }
});
