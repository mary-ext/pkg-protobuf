// deno-lint-ignore-file no-explicit-any

import { type BitSet, getBit, setBit } from './bitset.ts';
import { decodeUtf8, encodeUtf8Into, lazy, lazyProperty } from './utils.ts';

const CHUNK_SIZE = 1024;

type Identity<T> = T;
type Flatten<T> = Identity<{ [K in keyof T]: T[K] }>;

type WireType = 0 | 1 | 2 | 5;

type Key = string | number;

type InputType =
	| 'array'
	| 'bigint'
	| 'boolean'
	| 'bytes'
	| 'map'
	| 'number'
	| 'object'
	| 'string';

type RangeType =
	| 'float'
	| 'int32'
	| 'int64'
	| 'uint32'
	| 'uint64';

// #region Schema issue types
type IssueLeaf =
	| { ok: false; code: 'unexpected_eof' }
	| { ok: false; code: 'invalid_wire'; expected: WireType }
	| { ok: false; code: 'missing_value' }
	| { ok: false; code: 'invalid_type'; expected: InputType }
	| { ok: false; code: 'invalid_range'; type: RangeType };

type IssueTree =
	| IssueLeaf
	| { ok: false; code: 'prepend'; key: Key; tree: IssueTree };

export type Issue = Readonly<
	| { code: 'unexpected_eof'; path: Key[] }
	| { code: 'invalid_wire'; path: Key[]; expected: WireType }
	| { code: 'missing_value'; path: Key[] }
	| { code: 'invalid_type'; path: Key[]; expected: InputType }
	| { code: 'invalid_range'; path: Key[]; type: RangeType }
>;

const EOF_ISSUE: IssueLeaf = { ok: false, code: 'unexpected_eof' };

const ARRAY_TYPE_ISSUE: IssueLeaf = { ok: false, code: 'invalid_type', expected: 'array' };
const BIGINT_TYPE_ISSUE: IssueLeaf = { ok: false, code: 'invalid_type', expected: 'bigint' };
const BOOLEAN_TYPE_ISSUE: IssueLeaf = { ok: false, code: 'invalid_type', expected: 'boolean' };
const BYTES_TYPE_ISSUE: IssueLeaf = { ok: false, code: 'invalid_type', expected: 'bytes' };
const MAP_TYPE_ISSUE: IssueLeaf = { ok: false, code: 'invalid_type', expected: 'map' };
const NUMBER_TYPE_ISSUE: IssueLeaf = { ok: false, code: 'invalid_type', expected: 'number' };
const OBJECT_TYPE_ISSUE: IssueLeaf = { ok: false, code: 'invalid_type', expected: 'object' };
const STRING_TYPE_ISSUE: IssueLeaf = { ok: false, code: 'invalid_type', expected: 'string' };

const FLOAT_RANGE_ISSUE: IssueLeaf = { ok: false, code: 'invalid_range', type: 'float' };
const INT32_RANGE_ISSUE: IssueLeaf = { ok: false, code: 'invalid_range', type: 'int32' };
const INT64_RANGE_ISSUE: IssueLeaf = { ok: false, code: 'invalid_range', type: 'int64' };
const UINT32_RANGE_ISSUE: IssueLeaf = { ok: false, code: 'invalid_range', type: 'uint32' };
const UINT64_RANGE_ISSUE: IssueLeaf = { ok: false, code: 'invalid_range', type: 'uint64' };

// #__NO_SIDE_EFFECTS__
const prependPath = (key: Key, tree: IssueTree): IssueTree => {
	return { ok: false, code: 'prepend', key, tree };
};

// #region Error formatting utilities

const cloneIssueWithPath = (issue: IssueLeaf, path: Key[]): Issue => {
	const { ok: _ok, ...clone } = issue;

	return { ...clone, path };
};

const collectIssues = (tree: IssueTree, path: Key[] = [], issues: Issue[] = []): Issue[] => {
	for (;;) {
		switch (tree.code) {
			case 'prepend': {
				path.push(tree.key);
				tree = tree.tree;
				continue;
			}
			default: {
				issues.push(cloneIssueWithPath(tree, path));
				return issues;
			}
		}
	}
};

const formatIssueTree = (tree: IssueTree): string => {
	let path = '';
	for (;;) {
		switch (tree.code) {
			case 'prepend': {
				path += `.${tree.key}`;
				tree = tree.tree;
				continue;
			}
		}

		break;
	}

	let message: string;
	switch (tree.code) {
		case 'missing_value':
			message = 'required field is missing';
			break;
		case 'invalid_wire':
			message = `expected wire type ${tree.expected}`;
			break;
		case 'unexpected_eof':
			message = `unexpected end of input`;
			break;
		case 'invalid_type':
			message = `expected ${tree.expected}`;
			break;
		case 'invalid_range':
			message = `value out of range for ${tree.type}`;
			break;
		default:
			message = 'unknown error';
			break;
	}

	return `${tree.code} at ${path || '.'} (${message})`;
};

// #endregion

// #region Result types

export type Ok<T> = {
	ok: true;
	value: T;
};
export type Err = {
	ok: false;
	readonly message: string;
	readonly issues: readonly Issue[];
	throw(): never;
};

export type Result<T> = Ok<T> | Err;

export class ProtobufError extends Error {
	override readonly name = 'ProtobufError';

	#issueTree: IssueTree;

	constructor(issueTree: IssueTree) {
		super();

		this.#issueTree = issueTree;
	}

	override get message(): string {
		return formatIssueTree(this.#issueTree);
	}

	get issues(): readonly Issue[] {
		return collectIssues(this.#issueTree);
	}
}

class ErrImpl implements Err {
	readonly ok = false;

	#issueTree: IssueTree;

	constructor(issueTree: IssueTree) {
		this.#issueTree = issueTree;
	}

	get message(): string {
		return formatIssueTree(this.#issueTree);
	}

	get issues(): readonly Issue[] {
		return collectIssues(this.#issueTree);
	}

	throw(): never {
		throw new ProtobufError(this.#issueTree);
	}
}

const createDecoderState = (buffer: Uint8Array): DecoderState => {
	return {
		b: buffer,
		p: 0,
		v: null,
	};
};

const createEncoderState = (): EncoderState => {
	return {
		c: [],
		b: new Uint8Array(CHUNK_SIZE),
		v: null,
		p: 0,
		l: 0,
	};
};

/**
 * gracefully decode protobuf message
 * @param schema message schema
 * @param buffer byte array
 * @returns decode result
 */
// #__NO_SIDE_EFFECTS__
export const tryDecode = <TSchema extends MessageSchema>(
	schema: TSchema,
	buffer: Uint8Array,
): Result<InferOutput<TSchema>> => {
	const state = createDecoderState(buffer);

	const result = schema['~~decode'](state);

	if (result.ok) {
		return result as Ok<InferOutput<TSchema>>;
	}

	return new ErrImpl(result);
};

/**
 * gracefully encode protobuf message
 * @param schema message schema
 * @param value JavaScript value
 * @returns encode result
 */
// #__NO_SIDE_EFFECTS__
export const tryEncode = <TSchema extends MessageSchema>(
	schema: TSchema,
	value: InferInput<TSchema>,
): Result<Uint8Array> => {
	const state = createEncoderState();

	const result = schema['~~encode'](state, value);
	if (result !== undefined) {
		return new ErrImpl(result);
	}

	return { ok: true, value: finishEncode(state) };
};

/**
 * decode protobuf message
 * @param schema message schema
 * @param buffer byte array
 * @returns decoded JavaScript value
 * @throws {ProtobufError} when decoding fails
 */
// #__NO_SIDE_EFFECTS__
export const decode = <TSchema extends MessageSchema>(
	schema: TSchema,
	buffer: Uint8Array,
): InferOutput<TSchema> => {
	const state = createDecoderState(buffer);

	const result = schema['~~decode'](state);

	if (result.ok) {
		return result.value as InferOutput<TSchema>;
	}

	throw new ProtobufError(result);
};

/**
 * encode protobuf message
 * @param schema message schema
 * @param value JavaScript value
 * @returns encoded byte array
 * @throws {ProtobufError} when encoding fails
 */
// #__NO_SIDE_EFFECTS__
export const encode = <TSchema extends MessageSchema>(
	schema: TSchema,
	value: InferInput<TSchema>,
): Uint8Array => {
	const state = createEncoderState();

	const result = schema['~~encode'](state, value);

	if (result !== undefined) {
		throw new ProtobufError(result);
	}

	return finishEncode(state);
};

// #region Raw decoders

interface DecoderState {
	b: Uint8Array;
	p: number;
	v: DataView | null;
}

const readVarint = (state: DecoderState): RawResult<number> => {
	const buf = state.b;
	let pos = state.p;

	let result = 0;
	let shift = 0;
	let byte;

	do {
		if (pos >= buf.length) {
			return EOF_ISSUE;
		}
		byte = buf[pos++];
		result |= (byte & 0x7F) << shift;
		shift += 7;
	} while (byte & 0x80);

	state.p = pos;
	return { ok: true, value: result };
};

const readBytes = (state: DecoderState, length: number): RawResult<Uint8Array> => {
	const buf = state.b;

	const start = state.p;
	const end = start + length;

	if (end > buf.length) {
		return EOF_ISSUE;
	}

	state.p = end;
	return { ok: true, value: buf.subarray(start, end) };
};

const skipField = (state: DecoderState, wire: WireType): RawResult<void> => {
	switch (wire) {
		case 0: {
			const result = readVarint(state);
			if (!result.ok) {
				return result;
			}

			break;
		}
		case 1: {
			if (state.p + 8 > state.b.length) {
				return EOF_ISSUE;
			}

			state.p += 8;
			break;
		}
		case 2: {
			const length = readVarint(state);
			if (!length.ok) {
				return length;
			}

			if (state.p + length.value > state.b.length) {
				return EOF_ISSUE;
			}

			state.p += length.value;
			break;
		}
		case 5: {
			if (state.p + 4 > state.b.length) {
				return EOF_ISSUE;
			}

			state.p += 4;
			break;
		}
	}

	return { ok: true, value: undefined };
};

// #region Raw encoders

interface EncoderState {
	c: Uint8Array[];
	b: Uint8Array;
	v: DataView | null;
	p: number;
	l: number;
}

const resizeIfNeeded = (state: EncoderState, needed: number): void => {
	const buf = state.b;
	const pos = state.p;

	if (buf.byteLength < pos + needed) {
		state.c.push(buf.subarray(0, pos));
		state.l += pos;

		state.b = new Uint8Array(Math.max(CHUNK_SIZE, needed));
		state.v = null;
		state.p = 0;
	}
};

const writeVarint = (state: EncoderState, input: number | bigint): void => {
	if (typeof input === 'bigint') {
		resizeIfNeeded(state, 10);

		// Handle negative BigInt values properly for two's complement
		let n = input;
		if (n < 0n) {
			// Convert to unsigned representation for encoding
			n = (1n << 64n) + n;
		}

		while (n >= 0x80n) {
			state.b[state.p++] = Number(n & 0x7fn) | 0x80;
			n >>= 7n;
		}

		state.b[state.p++] = Number(n);
	} else {
		resizeIfNeeded(state, 5);

		let n = input >>> 0;
		while (n >= 0x80) {
			state.b[state.p++] = (n & 0x7f) | 0x80;
			n >>>= 7;
		}

		state.b[state.p++] = n;
	}
};

// Helper function to calculate varint length without encoding
const getVarintLength = (value: number): number => {
	if (value < 0x80) return 1;
	if (value < 0x4000) return 2;
	if (value < 0x200000) return 3;
	if (value < 0x10000000) return 4;
	return 5;
};

const writeBytes = (state: EncoderState, bytes: Uint8Array): void => {
	resizeIfNeeded(state, bytes.length);

	state.b.set(bytes, state.p);
	state.p += bytes.length;
};

const finishEncode = (state: EncoderState): Uint8Array => {
	const chunks = state.c;

	if (chunks.length === 0) {
		return state.b.subarray(0, state.p);
	}

	const buffer = new Uint8Array(state.l + state.p);

	let written = 0;
	for (let idx = 0, len = chunks.length; idx < len; idx++) {
		const chunk = chunks[idx];

		buffer.set(chunk, written);
		written += chunk.length;
	}

	buffer.set(state.b.subarray(0, state.p), written);
	return buffer;
};

// #endregion

// #region Common utilities

const getDataView = (state: EncoderState | DecoderState): DataView => {
	return state.v ??= new DataView(state.b.buffer, state.b.byteOffset, state.b.byteLength);
};

// #endregion

// #region Base schema

// Private symbols meant to hold types
declare const kType: unique symbol;
type kType = typeof kType;

// We need a special symbol to hold the types for objects due to their
// recursive nature.
declare const kObjectType: unique symbol;
type kObjectType = typeof kObjectType;

type RawResult<T = unknown> = Ok<T> | IssueTree;

type Decoder = (this: void, state: DecoderState) => RawResult;

type Encoder = (this: void, state: EncoderState, input: unknown) => IssueTree | void;

export interface BaseSchema<TInput = unknown, TOutput = TInput> {
	readonly kind: 'schema';
	readonly type: string;
	readonly wire: WireType;
	readonly '~decode': Decoder;
	readonly '~encode': Encoder;

	readonly [kType]?: { in: TInput; out: TOutput };
}

export type InferInput<T extends BaseSchema> = T extends { [kObjectType]?: any }
	? NonNullable<T[kObjectType]>['in']
	: NonNullable<T[kType]>['in'];

export type InferOutput<T extends BaseSchema> = T extends { [kObjectType]?: any }
	? NonNullable<T[kObjectType]>['out']
	: NonNullable<T[kType]>['out'];

// #region String schema
export interface StringSchema extends BaseSchema<string> {
	readonly type: 'string';
	readonly wire: 2;
}

const STRING_SINGLETON: StringSchema = {
	kind: 'schema',
	type: 'string',
	wire: 2,
	'~decode'(state) {
		const length = readVarint(state);
		if (!length.ok) {
			return length;
		}

		const bytes = readBytes(state, length.value);
		if (!bytes.ok) {
			return bytes;
		}

		return { ok: true, value: decodeUtf8(bytes.value) };
	},
	'~encode'(state, input) {
		if (typeof input !== 'string') {
			return STRING_TYPE_ISSUE;
		}

		// 1. Estimate the length of the header based on the UTF-16 size of the string
		// 2. Directly write the string at the estimated location, retrieving the actual length
		// 3. Write the header now that the length is available
		// 4. If the estimation was wrong, correct the placement of the string

		// JS strings are UTF-16, worst case UTF-8 length is length * 3
		const strLength = input.length;
		resizeIfNeeded(state, strLength * 3 + 5); // +5 for max varint length

		const estimatedHeaderSize = getVarintLength(strLength);
		const estimatedPosition = state.p + estimatedHeaderSize;
		const actualLength = encodeUtf8Into(state.b, input, estimatedPosition);

		const actualHeaderSize = getVarintLength(actualLength);
		if (estimatedHeaderSize !== actualHeaderSize) {
			// Estimation was incorrect, move the bytes to the real place
			state.b.copyWithin(state.p + actualHeaderSize, estimatedPosition, estimatedPosition + actualLength);
		}

		writeVarint(state, actualLength);
		state.p += actualLength;
	},
};

/**
 * creates a string schema
 * strings are encoded as UTF-8 with length-prefixed wire format
 * @returns string schema
 */
// #__NO_SIDE_EFFECTS__
export const string = (): StringSchema => {
	return STRING_SINGLETON;
};

// #region Bytes schema
export interface BytesSchema extends BaseSchema<Uint8Array> {
	readonly type: 'bytes';
	readonly wire: 2;
}

const BYTES_SINGLETON: BytesSchema = {
	kind: 'schema',
	type: 'bytes',
	wire: 2,
	'~decode'(state) {
		const length = readVarint(state);
		if (!length.ok) {
			return length;
		}

		return readBytes(state, length.value);
	},
	'~encode'(state, input) {
		if (!(input instanceof Uint8Array)) {
			return BYTES_TYPE_ISSUE;
		}

		resizeIfNeeded(state, 5 + input.length);
		writeVarint(state, input.length);
		writeBytes(state, input);
	},
};

/**
 * creates a bytes schema
 * handles arbitrary binary data as Uint8Array with length-prefixed wire format
 * @returns bytes schema
 */
// #__NO_SIDE_EFFECTS__
export const bytes = (): BytesSchema => {
	return BYTES_SINGLETON;
};

// #region Boolean schema
export interface BooleanSchema extends BaseSchema<boolean> {
	readonly type: 'boolean';
	readonly wire: 0;
}

const BOOLEAN_SINGLETON: BooleanSchema = {
	kind: 'schema',
	type: 'boolean',
	wire: 0,
	'~decode'(state) {
		const result = readVarint(state);
		if (!result.ok) {
			return result;
		}

		return { ok: true, value: result.value !== 0 };
	},
	'~encode'(state, input) {
		if (typeof input !== 'boolean') {
			return BOOLEAN_TYPE_ISSUE;
		}

		writeVarint(state, input ? 1 : 0);
	},
};

/**
 * creates a boolean schema
 * booleans are encoded as varint (0 for false, 1 for true)
 * @returns boolean schema
 */
// #__NO_SIDE_EFFECTS__
export const boolean = (): BooleanSchema => {
	return BOOLEAN_SINGLETON;
};

// #region Double schema
export interface DoubleSchema extends BaseSchema<number> {
	readonly type: 'double';
	readonly wire: 1;
}

const DOUBLE_SINGLETON: DoubleSchema = {
	kind: 'schema',
	type: 'double',
	wire: 1,
	'~decode'(state) {
		const view = getDataView(state);
		const value = view.getFloat64(state.p, true);

		state.p += 8;
		return { ok: true, value };
	},
	'~encode'(state, input) {
		if (typeof input !== 'number') {
			return NUMBER_TYPE_ISSUE;
		}

		resizeIfNeeded(state, 8);

		const view = getDataView(state);
		view.setFloat64(state.p, input, true);

		state.p += 8;
	},
};

/**
 * creates a double-precision floating point schema
 * uses 64-bit IEEE 754 format, encoded as 8 bytes in little-endian
 * @returns double schema
 */
// #__NO_SIDE_EFFECTS__
export const double = (): DoubleSchema => {
	return DOUBLE_SINGLETON;
};

// #region Float schema
export interface FloatSchema extends BaseSchema<number> {
	readonly type: 'float';
	readonly wire: 5;
}

const FLOAT_SINGLETON: FloatSchema = {
	kind: 'schema',
	type: 'float',
	wire: 5,
	'~decode'(state) {
		const view = getDataView(state);
		const value = view.getFloat32(state.p, true);

		state.p += 4;
		return { ok: true, value };
	},
	'~encode'(state, input) {
		if (typeof input !== 'number') {
			return NUMBER_TYPE_ISSUE;
		}
		if (isFinite(input)) {
			const abs = Math.abs(input);

			if ((abs > 3.4028235e38 || (abs < 1.175494e-38 && input !== 0))) {
				return FLOAT_RANGE_ISSUE;
			}
		}

		resizeIfNeeded(state, 4);

		const view = getDataView(state);
		view.setFloat32(state.p, input, true);

		state.p += 4;
	},
};

/**
 * creates a single-precision floating point schema
 * uses 32-bit IEEE 754 format, encoded as 4 bytes in little-endian
 * @returns float schema
 */
// #__NO_SIDE_EFFECTS__
export const float = (): FloatSchema => {
	return FLOAT_SINGLETON;
};

// #region Int32 schema
export interface Int32Schema extends BaseSchema<number> {
	readonly type: 'int32';
	readonly wire: 0;
}

const INT32_SINGLETON: Int32Schema = {
	kind: 'schema',
	type: 'int32',
	wire: 0,
	'~decode'(state) {
		const result = readVarint(state);
		if (!result.ok) {
			return result;
		}

		// Read as unsigned, then convert to signed 32-bit (handling sign extension)
		const value = result.value | 0;

		return { ok: true, value };
	},
	'~encode'(state, input) {
		if (typeof input !== 'number') {
			return NUMBER_TYPE_ISSUE;
		}
		if (input < -0x80000000 || input > 0x7fffffff) {
			return INT32_RANGE_ISSUE;
		}

		const n = input | 0;

		writeVarint(state, n);
	},
};

/**
 * creates a 32-bit signed integer schema
 * uses varint encoding. values must be in range [-2^31, 2^31-1]
 * @returns int32 schema
 */
// #__NO_SIDE_EFFECTS__
export const int32 = (): Int32Schema => {
	return INT32_SINGLETON;
};

// #region Int64 schema
export interface Int64Schema extends BaseSchema<bigint> {
	readonly type: 'int64';
	readonly wire: 0;
}

const INT64_SINGLETON: Int64Schema = {
	kind: 'schema',
	type: 'int64',
	wire: 0,
	'~decode'(state) {
		const buf = state.b;
		let pos = state.p;

		let result = 0n;
		let shift = 0n;
		let byte;

		do {
			byte = buf[pos++];
			result |= BigInt(byte & 0x7F) << shift;
			shift += 7n;
		} while (byte & 0x80);

		state.p = pos;

		// Convert from unsigned to signed (two's complement)
		if (result >= (1n << 63n)) {
			result = result - (1n << 64n);
		}

		return { ok: true, value: result };
	},
	'~encode'(state, input) {
		if (typeof input !== 'bigint') {
			return BIGINT_TYPE_ISSUE;
		}
		if (input < -0x8000000000000000n || input > 0x7fffffffffffffffn) {
			return INT64_RANGE_ISSUE;
		}

		// Convert signed to unsigned representation for wire format
		let value = input;
		if (input < 0n) {
			value = input + 0x10000000000000000n;
		}

		writeVarint(state, value);
	},
};

/**
 * creates a 64-bit signed integer schema
 * uses varint encoding. values must be in range [-2^63, 2^63-1]
 * JavaScript values are represented as bigint
 * @returns int64 schema
 */
// #__NO_SIDE_EFFECTS__
export const int64 = (): Int64Schema => {
	return INT64_SINGLETON;
};

// #region Uint32 schema
export interface Uint32Schema extends BaseSchema<number> {
	readonly type: 'uint32';
	readonly wire: 0;
}

const UINT32_SINGLETON: Uint32Schema = {
	kind: 'schema',
	type: 'uint32',
	wire: 0,
	'~decode'(state) {
		const result = readVarint(state);
		if (!result.ok) {
			return result;
		}

		// Limit to unsigned 32-bit
		const value = result.value >>> 0;

		return { ok: true, value };
	},
	'~encode'(state, input) {
		if (typeof input !== 'number') {
			return NUMBER_TYPE_ISSUE;
		}
		if (input < 0 || input > 0xffffffff) {
			return UINT32_RANGE_ISSUE;
		}

		writeVarint(state, input >>> 0);
	},
};

/**
 * creates a 32-bit unsigned integer schema
 * uses varint encoding. values must be in range [0, 2^32-1]
 * @returns uint32 schema
 */
// #__NO_SIDE_EFFECTS__
export const uint32 = (): Uint32Schema => {
	return UINT32_SINGLETON;
};

// #region Uint64 schema
export interface Uint64Schema extends BaseSchema<bigint> {
	readonly type: 'uint64';
	readonly wire: 0;
}

const UINT64_SINGLETON: Uint64Schema = {
	kind: 'schema',
	type: 'uint64',
	wire: 0,
	'~decode'(state) {
		const buf = state.b;
		let pos = state.p;

		let result = 0n;
		let shift = 0n;
		let byte;

		do {
			byte = buf[pos++];
			result |= BigInt(byte & 0x7F) << shift;
			shift += 7n;
		} while (byte & 0x80);

		state.p = pos;
		return { ok: true, value: result };
	},
	'~encode'(state, input) {
		if (typeof input !== 'bigint') {
			return BIGINT_TYPE_ISSUE;
		}
		if (input < 0n) {
			return UINT64_RANGE_ISSUE;
		}

		writeVarint(state, input);
	},
};

/**
 * creates a 64-bit unsigned integer schema
 * uses varint encoding. values must be in range [0, 2^64-1]
 * JavaScript values are represented as bigint
 * @returns uint64 schema
 */
// #__NO_SIDE_EFFECTS__
export const uint64 = (): Uint64Schema => {
	return UINT64_SINGLETON;
};

// #region Sint32 schema (zigzag encoding)
export interface Sint32Schema extends BaseSchema<number> {
	readonly type: 'sint32';
	readonly wire: 0;
}

const SINT32_SINGLETON: Sint32Schema = {
	kind: 'schema',
	type: 'sint32',
	wire: 0,
	'~decode'(state) {
		const result = readVarint(state);
		if (!result.ok) {
			return result;
		}

		const n = result.value;
		return { ok: true, value: (n >>> 1) ^ (-(n & 1)) };
	},
	'~encode'(state, input) {
		if (typeof input !== 'number') {
			return NUMBER_TYPE_ISSUE;
		}
		if (input < -0x80000000 || input > 0x7fffffff) {
			return INT32_RANGE_ISSUE;
		}

		const n = input | 0;

		writeVarint(state, (n << 1) ^ (n >> 31));
	},
};

/**
 * creates a 32-bit signed integer schema
 * uses zigzag encoding to efficiently encode negative numbers. values must be in range [-2^31, 2^31-1]
 * @returns sint32 schema
 */
// #__NO_SIDE_EFFECTS__
export const sint32 = (): Sint32Schema => {
	return SINT32_SINGLETON;
};

// #region Sint64 schema (zigzag encoding with BigInt)
export interface Sint64Schema extends BaseSchema<bigint> {
	readonly type: 'sint64';
	readonly wire: 0;
}

const SINT64_SINGLETON: Sint64Schema = {
	kind: 'schema',
	type: 'sint64',
	wire: 0,
	'~decode'(state) {
		const buf = state.b;
		let pos = state.p;

		let result = 0n;
		let shift = 0n;
		let byte;

		do {
			byte = buf[pos++];
			result |= BigInt(byte & 0x7F) << shift;
			shift += 7n;
		} while (byte & 0x80);

		state.p = pos;

		return { ok: true, value: (result >> 1n) ^ (-(result & 1n)) };
	},
	'~encode'(state, input) {
		if (typeof input !== 'bigint') {
			return BIGINT_TYPE_ISSUE;
		}
		if (input < -0x8000000000000000n || input > 0x7fffffffffffffffn) {
			return INT64_RANGE_ISSUE;
		}

		writeVarint(state, (input << 1n) ^ (input >> 63n));
	},
};

/**
 * creates a 64-bit signed integer schema
 * uses zigzag encoding to efficiently encode negative numbers. values must be in range [-2^63, 2^63-1]
 * JavaScript values are represented as bigint
 * @returns sint64 schema
 */
// #__NO_SIDE_EFFECTS__
export const sint64 = (): Sint64Schema => {
	return SINT64_SINGLETON;
};

// #region Fixed32 schema
export interface Fixed32Schema extends BaseSchema<number> {
	readonly type: 'fixed32';
	readonly wire: 5;
}

const FIXED32_SINGLETON: Fixed32Schema = {
	kind: 'schema',
	type: 'fixed32',
	wire: 5,
	'~decode'(state) {
		const view = getDataView(state);
		const value = view.getUint32(state.p, true);

		state.p += 4;
		return { ok: true, value };
	},
	'~encode'(state, input) {
		if (typeof input !== 'number') {
			return NUMBER_TYPE_ISSUE;
		}
		if (input < 0 || input > 0xffffffff) {
			return UINT32_RANGE_ISSUE;
		}

		resizeIfNeeded(state, 4);

		const view = getDataView(state);
		view.setUint32(state.p, input, true);

		state.p += 4;
	},
};

/**
 * creates a 32-bit fixed-width unsigned integer schema.
 * always uses exactly 4 bytes in little-endian format. values must be in range [0, 2^32-1]
 * @returns fixed32 schema
 */
// #__NO_SIDE_EFFECTS__
export const fixed32 = (): Fixed32Schema => {
	return FIXED32_SINGLETON;
};

// #region Fixed64 schema
export interface Fixed64Schema extends BaseSchema<bigint> {
	readonly type: 'fixed64';
	readonly wire: 1;
}

const FIXED64_SINGLETON: Fixed64Schema = {
	kind: 'schema',
	type: 'fixed64',
	wire: 1,
	'~decode'(state) {
		const view = getDataView(state);

		// Read as two 32-bit values and combine into a BigInt
		const lo = view.getUint32(state.p, true);
		const hi = view.getUint32(state.p + 4, true);

		state.p += 8;
		return { ok: true, value: (BigInt(hi) << 32n) | BigInt(lo) };
	},
	'~encode'(state, input) {
		if (typeof input !== 'bigint') {
			return BIGINT_TYPE_ISSUE;
		}
		if (input < 0n) {
			return UINT64_RANGE_ISSUE;
		}

		resizeIfNeeded(state, 8);

		const view = getDataView(state);

		view.setUint32(state.p, Number(input & 0xffffffffn), true);
		view.setUint32(state.p + 4, Number(input >> 32n), true);

		state.p += 8;
	},
};

/**
 * creates a 64-bit fixed-width unsigned integer schema
 * always uses exactly 8 bytes in little-endian format. values must be in range [0, 2^64-1]
 * JavaScript values are represented as bigint
 *
 * @returns fixed64 schema
 */
// #__NO_SIDE_EFFECTS__
export const fixed64 = (): Fixed64Schema => {
	return FIXED64_SINGLETON;
};

// #region Sfixed32 schema
export interface Sfixed32Schema extends BaseSchema<number> {
	readonly type: 'sfixed32';
	readonly wire: 5;
}

const SFIXED32_SINGLETON: Sfixed32Schema = {
	kind: 'schema',
	type: 'sfixed32',
	wire: 5,
	'~decode'(state) {
		const view = getDataView(state);
		const value = view.getInt32(state.p, true);

		state.p += 4;
		return { ok: true, value };
	},
	'~encode'(state, input) {
		if (typeof input !== 'number') {
			return NUMBER_TYPE_ISSUE;
		}
		if (input < -0x80000000 || input > 0x7fffffff) {
			return INT32_RANGE_ISSUE;
		}

		resizeIfNeeded(state, 4);

		const view = getDataView(state);
		view.setInt32(state.p, input | 0, true);

		state.p += 4;
	},
};

/**
 * creates a 32-bit fixed-width signed integer schema
 * always uses exactly 4 bytes in little-endian format. values must be in range [-2^31, 2^31-1]
 * @returns sfixed32 schema
 */
// #__NO_SIDE_EFFECTS__
export const sfixed32 = (): Sfixed32Schema => {
	return SFIXED32_SINGLETON;
};

// #region Sfixed64 schema
export interface Sfixed64Schema extends BaseSchema<bigint> {
	readonly type: 'sfixed64';
	readonly wire: 1;
}

const SFIXED64_SINGLETON: Sfixed64Schema = {
	kind: 'schema',
	type: 'sfixed64',
	wire: 1,
	'~decode'(state) {
		const view = getDataView(state);

		// Read as two 32-bit values and combine into a BigInt
		const lo = view.getUint32(state.p, true);
		const hi = view.getInt32(state.p + 4, true); // High bits should be signed

		state.p += 8;

		// Combine into a single signed 64-bit bigint
		return { ok: true, value: (BigInt(hi) << 32n) | BigInt(lo) };
	},
	'~encode'(state, input) {
		if (typeof input !== 'bigint') {
			return BIGINT_TYPE_ISSUE;
		}
		if (input < -0x8000000000000000n || input > 0x7fffffffffffffffn) {
			return INT64_RANGE_ISSUE;
		}

		resizeIfNeeded(state, 8);

		const view = getDataView(state);

		view.setUint32(state.p, Number(input & 0xffffffffn), true);
		view.setInt32(state.p + 4, Number(input >> 32n), true);

		state.p += 8;
	},
};

/**
 * creates a 64-bit fixed-width signed integer schema
 * uses exactly 8 bytes in little-endian format. values must be in range [-2^63, 2^63-1]
 * JavaScript values are represented as bigint
 * @returns sfixed64 schema
 */
// #__NO_SIDE_EFFECTS__
export const sfixed64 = (): Sfixed64Schema => {
	return SFIXED64_SINGLETON;
};

// #region Repeated schema
export interface RepeatedSchema<TItem extends BaseSchema> extends BaseSchema<unknown[]> {
	readonly type: 'repeated';
	readonly wire: 2;
	readonly item: TItem;

	readonly [kObjectType]?: { in: InferInput<TItem>[]; out: InferOutput<TItem>[] };
}

/**
 * creates a value array schema
 * @param item item schema to repeat
 * @returns repeated schema
 */
// #__NO_SIDE_EFFECTS__
export const repeated = <TItem extends BaseSchema>(item: TItem | (() => TItem)): RepeatedSchema<TItem> => {
	const resolvedShape = lazy(() => {
		return typeof item === 'function' ? item() : item;
	});

	return {
		kind: 'schema',
		type: 'repeated',
		wire: 2,
		get item() {
			return lazyProperty(this, 'item', resolvedShape.value);
		},
		get '~decode'() {
			const shape = resolvedShape.value;

			const decoder: Decoder = (state) => {
				const length = readVarint(state);
				if (!length.ok) {
					return length;
				}

				const bytes = readBytes(state, length.value);
				if (!bytes.ok) {
					return bytes;
				}

				const children: DecoderState = {
					b: bytes.value,
					p: 0,
					v: null,
				};

				const array: any[] = [];

				let idx = 0;
				let issues: IssueTree | undefined;

				while (children.p < length.value) {
					const r = shape['~decode'](children);

					if (!r.ok) {
						return prependPath(idx, r);
					}

					array.push(r.value);
					idx++;
				}

				if (issues !== undefined) {
					return issues;
				}

				return { ok: true, value: array };
			};

			return lazyProperty(this, '~decode', decoder);
		},
		get '~encode'() {
			const shape = resolvedShape.value;

			const encoder: Encoder = (state, input) => {
				if (!Array.isArray(input)) {
					return ARRAY_TYPE_ISSUE;
				}

				const children: EncoderState = {
					c: [],
					b: new Uint8Array(CHUNK_SIZE),
					v: null,
					p: 0,
					l: 0,
				};

				for (let idx = 0, len = input.length; idx < len; idx++) {
					const result = shape['~encode'](children, input[idx]);

					if (result) {
						return prependPath(idx, result);
					}
				}

				const packed = finishEncode(children);

				writeVarint(state, packed.length);
				writeBytes(state, packed);
			};

			return lazyProperty(this, '~encode', encoder);
		},
	};
};

// #region Optional schema

type DefaultValue<TItem extends BaseSchema> =
	| InferOutput<TItem>
	| (() => InferOutput<TItem>)
	| undefined;

type InferOptionalOutput<
	TItem extends BaseSchema,
	TDefault extends DefaultValue<TItem>,
> = undefined extends TDefault ? InferOutput<TItem> | undefined : InferOutput<TItem>;

export interface OptionalSchema<
	TItem extends BaseSchema = BaseSchema,
	TDefault extends DefaultValue<TItem> = DefaultValue<TItem>,
> extends BaseSchema<InferInput<TItem> | undefined, InferOptionalOutput<TItem, TDefault>> {
	readonly type: 'optional';
	readonly wrapped: TItem;
	readonly default: TDefault;
}

/**
 * creates an optional field schema
 * @param wrapped schema to make optional
 * @param defaultValue default value when the field is not present
 * @returns optional field schema
 */
// #__NO_SIDE_EFFECTS__
export const optional: {
	<TItem extends BaseSchema>(wrapped: TItem): OptionalSchema<TItem, undefined>;
	<TItem extends BaseSchema, TDefault extends DefaultValue<TItem>>(
		wrapped: TItem,
		defaultValue: TDefault,
	): OptionalSchema<TItem, TDefault>;
} = (wrapped: BaseSchema, defaultValue?: any): OptionalSchema<any, any> => {
	return {
		kind: 'schema',
		type: 'optional',
		wrapped: wrapped,
		default: defaultValue,
		wire: wrapped.wire,
		'~decode'(state) {
			return wrapped['~decode'](state);
		},
		'~encode'(state, input) {
			return wrapped['~encode'](state, input);
		},
	};
};

const isOptionalSchema = (schema: BaseSchema): schema is OptionalSchema<any> => {
	return schema.type === 'optional';
};

// #region Message schema

export type LooseMessageShape = Record<string, any>;
export type MessageShape = Record<string, BaseSchema>;

export type OptionalObjectInputKeys<TShape extends MessageShape> = {
	[Key in keyof TShape]: TShape[Key] extends OptionalSchema<any, any> ? Key : never;
}[keyof TShape];

export type OptionalObjectOutputKeys<TShape extends MessageShape> = {
	[Key in keyof TShape]: TShape[Key] extends OptionalSchema<any, infer Default>
		? undefined extends Default ? Key
		: never
		: never;
}[keyof TShape];

type InferMessageInput<TShape extends MessageShape> = Flatten<
	& {
		-readonly [Key in Exclude<keyof TShape, OptionalObjectInputKeys<TShape>>]: InferInput<
			TShape[Key]
		>;
	}
	& {
		-readonly [Key in OptionalObjectInputKeys<TShape>]?: InferInput<TShape[Key]>;
	}
>;

type InferMessageOutput<TShape extends MessageShape> = Flatten<
	& {
		-readonly [Key in Exclude<keyof TShape, OptionalObjectOutputKeys<TShape>>]: InferOutput<
			TShape[Key]
		>;
	}
	& {
		-readonly [Key in OptionalObjectOutputKeys<TShape>]?: InferOutput<TShape[Key]>;
	}
>;

export interface MessageSchema<
	TShape extends LooseMessageShape = LooseMessageShape,
	TTags extends Record<keyof TShape, number> = Record<keyof TShape, number>,
> extends BaseSchema<Record<string, unknown>> {
	readonly type: 'message';
	readonly wire: 2;
	readonly shape: Readonly<TShape>;
	readonly tags: Readonly<TTags>;

	readonly '~~decode': Decoder;
	readonly '~~encode': Encoder;

	readonly [kObjectType]?: { in: InferMessageInput<TShape>; out: InferMessageOutput<TShape> };
}

interface MessageEntry {
	key: string;

	schema: BaseSchema;
	tag: number;
	wire: WireType;

	optional: boolean;

	wireIssue: IssueTree;
	missingIssue: IssueTree;
}

const ISSUE_MISSING: IssueLeaf = {
	ok: false,
	code: 'missing_value',
};

const set = (obj: Record<string, unknown>, key: string, value: unknown): void => {
	if (key === '__proto__') {
		Object.defineProperty(obj, key, { value });
	} else {
		obj[key] = value;
	}
};

/**
 * creates a structured message schema
 * @param shape message shape
 * @param tags fields mapped to tag numbers
 * @returns structured message schema
 */
// #__NO_SIDE_EFFECTS__
export const message = <TShape extends LooseMessageShape, const TTags extends Record<keyof TShape, number>>(
	shape: TShape,
	tags: TTags,
): MessageSchema<TShape, TTags> => {
	const resolvedEntries = lazy((): Record<number, MessageEntry> => {
		const resolved: Record<number, MessageEntry> = {};
		const obj = shape as MessageShape;

		for (const key in obj) {
			const schema = obj[key];
			const tag = tags[key];

			resolved[tag] = {
				key: key,
				schema: schema,
				tag: tag,
				wire: schema.wire,
				optional: isOptionalSchema(schema),
				wireIssue: prependPath(key, { ok: false, code: 'invalid_wire', expected: schema.wire }),
				missingIssue: prependPath(key, ISSUE_MISSING),
			};
		}

		return resolved;
	});

	return {
		kind: 'schema',
		type: 'message',
		wire: 2,
		tags: tags,
		get shape() {
			// if we just return the shape as is then it wouldn't be the same exact
			// shape when getters are present.
			const resolved = resolvedEntries.value;
			const obj: any = {};

			for (const index in resolved) {
				const entry = resolved[index];
				obj[entry.key] = entry.schema;
			}

			return lazyProperty(this, 'shape', obj as TShape);
		},

		get '~~decode'() {
			const shape = resolvedEntries.value;
			const len = Object.keys(shape).length;

			const decoder: Decoder = (state) => {
				let seenBits: BitSet = 0;
				let seenCount = 0;

				const obj: Record<string, unknown> = {};
				let issues: IssueTree | undefined;

				const end = state.b.length;
				while (state.p < end) {
					const prelude = readVarint(state);
					if (!prelude.ok) {
						return prelude;
					}

					const magic = prelude.value;
					const tag = magic >> 3;
					const wire = (magic & 0x7) as WireType;

					const entry = shape[tag];

					// We don't know what this tag is, skip
					if (!entry) {
						const result = skipField(state, wire);
						if (!result.ok) {
							return result;
						}

						continue;
					}

					// We've not seen this tag before
					if (!getBit(seenBits, tag)) {
						seenBits = setBit(seenBits, tag);
						seenCount++;
					}

					// It doesn't match with our wire, file an issue
					if (entry.wire !== wire) {
						return entry.wireIssue;
					}

					// Decode the value
					const result = entry.schema['~decode'](state);

					// Failed to decode, file an issue
					if (!result.ok) {
						return prependPath(entry.key, result);
					}

					/*#__INLINE__*/ set(obj, entry.key, result.value);
				}

				if (seenCount < len) {
					for (const strtag in shape) {
						const entry = shape[strtag];

						if (!getBit(seenBits, entry.tag)) {
							if (entry.optional) {
								const schema = entry.schema as OptionalSchema;

								let defaultValue = schema.default;
								if (defaultValue !== undefined) {
									if (typeof defaultValue === 'function') {
										defaultValue = defaultValue();
									}

									/*#__INLINE__*/ set(obj, entry.key, defaultValue);
								}
							} else {
								return entry.missingIssue;
							}
						}
					}
				}

				if (issues !== undefined) {
					return issues;
				}

				return { ok: true, value: obj };
			};

			return lazyProperty(this, '~~decode', decoder);
		},
		get '~decode'() {
			const raw = this['~~decode'];

			const decoder: Decoder = (state) => {
				const length = readVarint(state);
				if (!length.ok) {
					return length;
				}

				const bytes = readBytes(state, length.value);
				if (!bytes.ok) {
					return bytes;
				}

				const child: DecoderState = {
					b: bytes.value,
					p: 0,
					v: null,
				};

				return raw(child);
			};

			return lazyProperty(this, '~decode', decoder);
		},
		get '~~encode'() {
			const shape = resolvedEntries.value;

			const encoder: Encoder = (state, input) => {
				if (typeof input !== 'object' || input === null || Array.isArray(input)) {
					return OBJECT_TYPE_ISSUE;
				}

				const obj = input as Record<string, unknown>;

				for (const tag in shape) {
					const entry = shape[tag];
					const fieldValue = obj[entry.key];

					if (entry.optional && fieldValue === undefined) {
						continue;
					}

					writeVarint(state, (entry.tag << 3) | entry.wire);

					const result = entry.schema['~encode'](state, fieldValue);

					if (result) {
						return prependPath(entry.key, result);
					}
				}
			};

			return lazyProperty(this, '~~encode', encoder);
		},
		get '~encode'() {
			const raw = this['~~encode'];

			const encoder: Encoder = (state, input) => {
				const children: EncoderState = {
					c: [],
					b: new Uint8Array(CHUNK_SIZE),
					v: null,
					p: 0,
					l: 0,
				};

				const result = raw(children, input);
				if (result) {
					return result;
				}

				const chunk = finishEncode(children);

				writeVarint(state, chunk.length);
				writeBytes(state, chunk);
			};

			return lazyProperty(this, '~encode', encoder);
		},
	};
};

// #endregion

// #region Map schema
export type MapKeySchema =
	| BooleanSchema
	| Fixed32Schema
	| Fixed64Schema
	| Int32Schema
	| Int64Schema
	| Sint32Schema
	| Sint64Schema
	| StringSchema
	| Uint32Schema
	| Uint64Schema;

export type MapValueSchema = BaseSchema;

export interface MapSchema<TKey extends MapKeySchema, TValue extends MapValueSchema>
	extends BaseSchema<unknown[]> {
	readonly type: 'map';
	readonly wire: 2;
	readonly key: TKey;
	readonly value: TValue;

	readonly [kObjectType]?: {
		in: Map<InferInput<TKey>, InferInput<TValue>>;
		out: Map<InferOutput<TKey>, InferOutput<TValue>>;
	};
}

/**
 * creates a key-value map schema
 * @param key schema for map keys
 * @param value schema for map values
 * @returns map schema
 */
export const map = <TKey extends MapKeySchema, TValue extends MapValueSchema>(
	key: TKey,
	value: TValue,
): MapSchema<TKey, TValue> => {
	const Schema = repeated(message({ key, value }, { key: 1, value: 2 }));

	type Entry = { key: TKey; value: TValue };

	return {
		kind: 'schema',
		type: 'map',
		wire: 2,
		key,
		value,
		get '~decode'() {
			const decoder: Decoder = (state) => {
				const result = Schema['~decode'](state);
				if (!result.ok) {
					return result;
				}

				const map = new Map();

				const entries = result.value as Entry[];
				for (let idx = 0, len = entries.length; idx < len; idx++) {
					const entry = entries[idx];
					map.set(entry.key, entry.value);
				}

				return { ok: true, value: map };
			};

			return lazyProperty(this, '~decode', decoder);
		},
		get '~encode'() {
			const encoder: Encoder = (state, input) => {
				if (!(input instanceof Map)) {
					return MAP_TYPE_ISSUE;
				}

				const entries: Entry[] = [];
				for (const [key, value] of input) {
					entries.push({ key, value });
				}

				return Schema['~encode'](state, entries);
			};

			return lazyProperty(this, '~encode', encoder);
		},
	};
};

// #endregion

// #region Well-known types

/**
 * represents a point in time independent of any time zone or local calendar,
 * encoded as a count of seconds and fractions of seconds at nanosecond
 * resolution.
 */
export const Timestamp: MessageSchema<{
	seconds: OptionalSchema<Int64Schema, 0n>;
	nanos: OptionalSchema<Int32Schema, 0>;
}, {
	readonly seconds: 1;
	readonly nanos: 2;
}> = /*#__PURE__*/ message({
	seconds: /*#__PURE__*/ optional(/*#__PURE__*/ int64(), 0n),
	nanos: /*#__PURE__*/ optional(/*#__PURE__*/ int32(), 0),
}, {
	seconds: 1,
	nanos: 2,
});

/**
 * represents a signed, fixed-length span of time represented as a count of
 * seconds and fractions of seconds at nanosecond resolution.
 */
export const Duration: MessageSchema<{
	seconds: OptionalSchema<Int64Schema, 0n>;
	nanos: OptionalSchema<Int32Schema, 0>;
}, {
	readonly seconds: 1;
	readonly nanos: 2;
}> = /*#__PURE__*/ message({
	seconds: /*#__PURE__*/ optional(/*#__PURE__*/ int64(), 0n),
	nanos: /*#__PURE__*/ optional(/*#__PURE__*/ int32(), 0),
}, {
	seconds: 1,
	nanos: 2,
});

/**
 * contains an arbitrary serialized protocol buffer message along with a URL
 * that describes the type of the serialized message.
 */
export const Any: MessageSchema<{
	typeUrl: OptionalSchema<StringSchema, ''>;
	value: OptionalSchema<BytesSchema, Uint8Array<ArrayBuffer>>;
}, {
	readonly typeUrl: 1;
	readonly value: 2;
}> = /*#__PURE__*/ message({
	typeUrl: /*#__PURE__*/ optional(/*#__PURE__*/ string(), ''),
	value: /*#__PURE__*/ optional(/*#__PURE__*/ bytes(), /*#__PURE__*/ new Uint8Array(0)),
}, {
	typeUrl: 1,
	value: 2,
});

// #endregion
