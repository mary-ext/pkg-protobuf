// #__NO_SIDE_EFFECTS__
export const lazyProperty = <T>(obj: object, prop: string | number | symbol, value: T): T => {
	Object.defineProperty(obj, prop, { value });
	return value;
};

// #__NO_SIDE_EFFECTS__
export const lazy = <T>(getter: () => T): { readonly value: T } => {
	return {
		get value() {
			const value = getter();
			return lazyProperty(this, 'value', value);
		},
	};
};

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
const fromCharCode = String.fromCharCode;

export const decodeUtf8 = (from: Uint8Array, offset?: number, length?: number): string => {
	let buffer: Uint8Array;

	if (offset === undefined) {
		buffer = from;
	} else if (length === undefined) {
		buffer = from.subarray(offset);
	} else {
		buffer = from.subarray(offset, offset + length);
	}

	const end = buffer.length;
	if (end > 24) {
		return textDecoder.decode(buffer);
	}

	{
		let str = '';
		let idx = 0;

		for (; idx + 3 < end; idx += 4) {
			const a = buffer[idx];
			const b = buffer[idx + 1];
			const c = buffer[idx + 2];
			const d = buffer[idx + 3];

			if ((a | b | c | d) & 0x80) {
				return str + textDecoder.decode(buffer.subarray(idx));
			}

			str += fromCharCode(a, b, c, d);
		}

		for (; idx < end; idx++) {
			const x = buffer[idx];

			if (x & 0x80) {
				return str + textDecoder.decode(buffer.subarray(idx));
			}

			str += fromCharCode(x);
		}

		return str;
	}
};

export const encodeUtf8Into = (to: Uint8Array, str: string, offset?: number, length?: number): number => {
	let buffer: Uint8Array;

	if (offset === undefined) {
		buffer = to;
	} else if (length === undefined) {
		buffer = to.subarray(offset);
	} else {
		buffer = to.subarray(offset, offset + length);
	}

	const result = textEncoder.encodeInto(str, buffer);

	return result.written || 0;
};
