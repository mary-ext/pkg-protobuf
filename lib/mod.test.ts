import {
	assert,
	assertAlmostEquals,
	assertArrayIncludes,
	assertEquals,
	assertStringIncludes,
	assertThrows,
} from '@std/assert';
import { nanoid } from 'nanoid/non-secure';

import * as p from './mod.ts';

// #region Primitive types

Deno.test('string encoding/decoding', () => {
	const Message = p.message({ text: p.string() }, { text: 1 });

	const cases = [
		'',
		'hello world',
		'hello 🚀',
		'a'.repeat(1000),
		'Café',
		'おはようございます☀️',
		'नमस्ते',
		'Здравствуйте',
		'你'.repeat(43),
		'🌟'.repeat(32),
		'🚀🌟💻',
		'🏳️‍🌈🏳️‍⚧️',
	];

	for (const text of cases) {
		const encoded = p.encode(Message, { text });
		const decoded = p.decode(Message, encoded);

		assertEquals(decoded, { text });
	}
});

Deno.test('int32 encoding/decoding', () => {
	const Message = p.message({ value: p.int32() }, { value: 1 });

	const cases = [
		0,
		1,
		-1,
		127,
		-128,
		255,
		-256,
		32767,
		-32768,
		65535,
		-65536,
		2147483647, // max int32
		-2147483648, // min int32
	];

	for (const value of cases) {
		const encoded = p.encode(Message, { value });
		const decoded = p.decode(Message, encoded);

		assertEquals(decoded, { value });
	}
});

Deno.test('int64 encoding/decoding', () => {
	const Message = p.message({ value: p.int64() }, { value: 1 });

	const cases = [
		0n,
		1n,
		-1n,
		127n,
		-128n,
		9223372036854775807n, // max int64
		-9223372036854775808n, // min int64
	];

	for (const value of cases) {
		const encoded = p.encode(Message, { value });
		const decoded = p.decode(Message, encoded);

		assertEquals(decoded, { value });
	}
});

Deno.test('uint32 encoding/decoding', () => {
	const Message = p.message({ value: p.uint32() }, { value: 1 });

	const cases = [
		0,
		1,
		127,
		255,
		32767,
		65535,
		2147483647,
		4294967295, // max uint32
	];

	for (const value of cases) {
		const encoded = p.encode(Message, { value });
		const decoded = p.decode(Message, encoded);

		assertEquals(decoded, { value });
	}
});

Deno.test('uint64 encoding/decoding', () => {
	const Message = p.message({ value: p.uint64() }, { value: 1 });

	const cases = [
		0n,
		1n,
		127n,
		255n,
		18446744073709551615n, // max uint64
	];

	for (const value of cases) {
		const encoded = p.encode(Message, { value });
		const decoded = p.decode(Message, encoded);

		assertEquals(decoded, { value });
	}
});

Deno.test('sint32 encoding/decoding (zigzag)', () => {
	const schema = p.message({ value: p.sint32() }, { value: 1 });

	const testCases = [
		0,
		1,
		-1,
		2,
		-2,
		127,
		-128,
		2147483647, // max int32
		-2147483648, // min int32
	];

	for (const value of testCases) {
		const encoded = p.encode(schema, { value });
		const decoded = p.decode(schema, encoded);

		assertEquals(decoded, { value });
	}
});

Deno.test('sint64 encoding/decoding (zigzag)', () => {
	const Message = p.message({ value: p.sint64() }, { value: 1 });

	const cases = [
		0n,
		1n,
		-1n,
		2n,
		-2n,
		127n,
		-128n,
		9223372036854775807n, // max int64
		-9223372036854775808n, // min int64
	];

	for (const value of cases) {
		const encoded = p.encode(Message, { value });
		const decoded = p.decode(Message, encoded);

		assertEquals(decoded, { value });
	}
});

Deno.test('float encoding/decoding', () => {
	const Message = p.message({ value: p.float() }, { value: 1 });

	const cases = [
		0.0,
		1.0,
		-1.0,
		3.14159,
		-3.14159,
		1.5e10,
		-1.5e10,
		3.4028235e38, // close to max float32
		1.175494e-38, // close to min positive float32
		Infinity,
		-Infinity,
		NaN,
	];

	for (const value of cases) {
		const encoded = p.encode(Message, { value });
		const decoded = p.decode(Message, encoded);

		// Special handling for infinity values
		if (Number.isFinite(value)) {
			// For finite values, check they're close due to float precision
			// Use a more lenient tolerance for large numbers
			const tolerance = Math.abs(value) > 1e9 ? Math.abs(value) * 1e-6 : 1e-6;

			assertAlmostEquals(decoded.value, value, tolerance);
		} else {
			assertEquals(decoded.value, value);
		}
	}
});

Deno.test('double encoding/decoding', () => {
	const Message = p.message({ value: p.double() }, { value: 1 });

	const cases = [
		0.0,
		1.0,
		-1.0,
		3.141592653589793,
		-3.141592653589793,
		1.7976931348623157e+308, // close to max double
		2.2250738585072014e-308, // close to min positive double
		Infinity,
		-Infinity,
		NaN,
	];

	for (const value of cases) {
		const encoded = p.encode(Message, { value });
		const decoded = p.decode(Message, encoded);

		assertEquals(decoded, { value });
	}
});

Deno.test('float range validation', () => {
	const Message = p.message({ value: p.float() }, { value: 1 });

	// Test values that should cause range errors
	const invald = [
		3.4028236e38, // slightly above max float32
		-3.4028236e38, // slightly below min float32
		1e39, // way above max float32
		-1e39, // way below min float32
	];

	for (const value of invald) {
		assertThrows(() => p.encode(Message, { value }), Error, 'invalid_range');
	}

	// Test edge values that should work
	const valid = [
		3.4028235e38, // max float32
		-3.4028235e38, // min float32
		1.175494e-38, // min positive float32
		-1.175494e-38, // max negative float32
		0, // zero
		Infinity, // positive infinity
		-Infinity, // negative infinity
		NaN, // not a number
	];

	for (const value of valid) {
		const encoded = p.encode(Message, { value });
		void p.decode(Message, encoded);
	}
});

Deno.test('double range validation', () => {
	const Message = p.message({ value: p.double() }, { value: 1 });

	// JavaScript's number type is already IEEE 754 double precision,
	// so all numbers are valid for double. Test edge cases work correctly.
	const cases = [
		Number.MAX_VALUE, // max double
		-Number.MAX_VALUE, // min double
		Number.MIN_VALUE, // min positive double
		-Number.MIN_VALUE, // max negative double
		0, // zero
		Infinity, // positive infinity
		-Infinity, // negative infinity
		NaN, // not a number
	];

	for (const value of cases) {
		const encoded = p.encode(Message, { value });
		void p.decode(Message, encoded);
	}
});

Deno.test('boolean encoding/decoding', () => {
	const Message = p.message({ value: p.boolean() }, { value: 1 });

	const cases = [true, false];

	for (const value of cases) {
		const encoded = p.encode(Message, { value });
		const decoded = p.decode(Message, encoded);

		assertEquals(decoded, { value });
	}
});

Deno.test('bytes encoding/decoding', () => {
	const Message = p.message({ data: p.bytes() }, { data: 1 });

	const cases = [
		Uint8Array.from([]),
		Uint8Array.from([0]),
		Uint8Array.from([1, 2, 3, 4, 5]),
		Uint8Array.from([255, 254, 253]),
		new Uint8Array(Array.from({ length: 1000 }, (_, i) => i % 256)), // large array
	];

	for (const data of cases) {
		const encoded = p.encode(Message, { data });
		const decoded = p.decode(Message, encoded);

		assertEquals(decoded, { data });
	}
});

Deno.test('fixed32 encoding/decoding', () => {
	const Message = p.message({ value: p.fixed32() }, { value: 1 });

	const cases = [
		0,
		1,
		255,
		65535,
		4294967295, // max uint32
	];

	for (const value of cases) {
		const encoded = p.encode(Message, { value });
		const decoded = p.decode(Message, encoded);

		assertEquals(decoded, { value });
	}
});

Deno.test('fixed64 encoding/decoding', () => {
	const Message = p.message({ value: p.fixed64() }, { value: 1 });

	const cases = [
		0n,
		1n,
		255n,
		65535n,
		18446744073709551615n, // max uint64
	];

	for (const value of cases) {
		const encoded = p.encode(Message, { value });
		const decoded = p.decode(Message, encoded);

		assertEquals(decoded, { value });
	}
});

Deno.test('sfixed32 encoding/decoding', () => {
	const Message = p.message({ value: p.sfixed32() }, { value: 1 });

	const cases = [
		0,
		1,
		-1,
		2147483647, // max int32
		-2147483648, // min int32
	];

	for (const value of cases) {
		const encoded = p.encode(Message, { value });
		const decoded = p.decode(Message, encoded);

		assertEquals(decoded, { value });
	}
});

Deno.test('sfixed64 encoding/decoding', () => {
	const Message = p.message({ value: p.sfixed64() }, { value: 1 });

	const cases = [
		0n,
		1n,
		-1n,
		9223372036854775807n, // max int64
		-9223372036854775808n, // min int64
	];

	for (const value of cases) {
		const encoded = p.encode(Message, { value });
		const decoded = p.decode(Message, encoded);

		assertEquals(decoded, { value });
	}
});

// #endregion

// #region Complex types

Deno.test('repeated fields', () => {
	const cases = [
		{
			numbers: [],
			strings: [],
		},
		{
			numbers: [1],
			strings: ['hello'],
		},
		{
			numbers: [1, 2, 3, -1, -2],
			strings: ['hello', 'world', ''],
		},
		{
			numbers: Array.from({ length: 100 }, (_, i) => i),
			strings: Array.from({ length: 100 }, (_, i) => `item${i}`),
		},
	];

	{
		const Message = p.message({
			numbers: p.repeated(p.int32(), false),
			strings: p.repeated(p.string(), false),
		}, {
			numbers: 1,
			strings: 2,
		});

		for (const data of cases) {
			const encoded = p.encode(Message, data);
			const decoded = p.decode(Message, encoded);

			assertEquals(decoded, data);
		}
	}

	{
		const Message = p.message({
			numbers: p.repeated(p.int32(), true),
			strings: p.repeated(p.string(), true),
		}, {
			numbers: 1,
			strings: 2,
		});

		for (const data of cases) {
			const encoded = p.encode(Message, data);
			const decoded = p.decode(Message, encoded);

			assertEquals(decoded, data);
		}
	}
});

Deno.test('messages with optional fields', () => {
	const Message = p.message({
		required: p.string(),
		withDefault: p.optional(p.string(), 'default_value'),
		withFunctionDefault: p.optional(p.int32(), () => 42),
		withoutDefault: p.optional(p.string()),
	}, {
		required: 1,
		withDefault: 2,
		withFunctionDefault: 3,
		withoutDefault: 4,
	});

	{
		const full = {
			required: 'hello',
			withDefault: 'custom',
			withFunctionDefault: 99,
			withoutDefault: 'present',
		};

		const encoded = p.encode(Message, full);
		const decoded = p.decode(Message, encoded);

		assertEquals(decoded, full);
	}
	{
		const minimal = { required: 'hello' };

		const encoded = p.encode(Message, minimal);
		const decoded = p.decode(Message, encoded);

		assertEquals(decoded, {
			required: 'hello',
			withDefault: 'default_value',
			withFunctionDefault: 42,
			// withoutDefault should be undefined (not present)
		});
	}

	{
		const partial = {
			required: 'hello',
			withDefault: 'custom_value',
		};

		const encoded = p.encode(Message, partial);
		const decoded = p.decode(Message, encoded);

		assertEquals(decoded, {
			required: 'hello',
			withDefault: 'custom_value',
			withFunctionDefault: 42,
			// withoutDefault should be undefined (not present)
		});
	}
});

Deno.test('empty messages', () => {
	const Message = p.message({}, {});

	const encoded = p.encode(Message, {});
	const decoded = p.decode(Message, encoded);

	assertEquals(decoded, {});
});

Deno.test('nested messages', () => {
	const Address = p.message({
		street: p.string(),
		city: p.string(),
		zipCode: p.optional(p.string()),
	}, {
		street: 1,
		city: 2,
		zipCode: 3,
	});

	const Person = p.message({
		name: p.string(),
		age: p.int32(),
		address: Address,
		addresses: p.repeated(Address),
	}, {
		name: 1,
		age: 2,
		address: 3,
		addresses: 4,
	});

	const data = {
		name: 'John Doe',
		age: 30,
		address: {
			street: '123 Main St',
			city: 'Anytown',
			zipCode: '12345',
		},
		addresses: [
			{
				street: '456 Oak Ave',
				city: 'Other City',
			},
			{
				street: '789 Pine Rd',
				city: 'Another City',
				zipCode: '67890',
			},
		],
	};

	const encoded = p.encode(Person, data);
	const decoded = p.decode(Person, encoded);

	assertEquals(decoded, data);
});

Deno.test('self-referential messages', () => {
	const Node = p.message({
		value: p.int32(),
		get next() {
			return p.optional(Node);
		},
	}, {
		value: 1,
		next: 2,
	});

	{
		const encoded = p.encode(Node, { value: 42 });
		const decoded = p.decode(Node, encoded);

		assertEquals(decoded, { value: 42 });
	}

	{
		const encoded = p.encode(Node, { value: 1, next: { value: 2 } });
		const decoded = p.decode(Node, encoded);

		assertEquals(decoded, { value: 1, next: { value: 2 } });
	}

	{
		const complex: p.InferInput<typeof Node> = {
			value: 1,
			next: {
				value: 2,
				next: {
					value: 3,
					next: {
						value: 4,
						next: {
							value: 5,
						},
					},
				},
			},
		};

		const encoded = p.encode(Node, complex);
		const decoded = p.decode(Node, encoded);

		assertEquals(decoded, complex);
	}
});

Deno.test('map type', () => {
	const Person = p.message({
		id: p.int32(),
		name: p.string(),
	}, {
		id: 1,
		name: 2,
	});

	const PersonMap = p.map(p.string(), Person);
	type PersonMap = p.InferInput<typeof PersonMap>;

	const Message = p.message({
		map: PersonMap,
	}, {
		map: 1,
	});

	{
		const map: PersonMap = [];

		const encoded = p.encode(Message, { map });
		const decoded = p.decode(Message, encoded);

		assertEquals(decoded, { map });
	}

	{
		const map: PersonMap = [{ key: 'item1', value: { id: 1, name: 'first' } }];

		const encoded = p.encode(Message, { map });
		const decoded = p.decode(Message, encoded);

		assertEquals(decoded, { map });
	}

	{
		const map: PersonMap = [
			{ key: 'item1', value: { id: 1, name: 'first' } },
			{ key: 'item2', value: { id: 2, name: 'second' } },
		];

		const encoded = p.encode(Message, { map });
		const decoded = p.decode(Message, encoded);

		assertEquals(decoded, { map });
	}
});

Deno.test('Timestamp type', () => {
	{
		const encoded = p.encode(p.Timestamp, {});
		const decoded = p.decode(p.Timestamp, encoded);

		assertEquals(decoded, { seconds: 0n, nanos: 0 });
	}

	{
		const data: p.InferInput<typeof p.Timestamp> = {
			seconds: 1609459200n, // 2021-01-01 00:00:00 UTC
			nanos: 123456789,
		};

		const encoded = p.encode(p.Timestamp, data);
		const decoded = p.decode(p.Timestamp, encoded);

		assertEquals(decoded, data);
	}
});

Deno.test('Duration type', () => {
	{
		const data: p.InferInput<typeof p.Duration> = {
			seconds: 3661n, // 1 hour, 1 minute, 1 second
			nanos: 500000000, // 0.5 seconds
		};

		const encoded = p.encode(p.Duration, data);
		const decoded = p.decode(p.Duration, encoded);

		assertEquals(decoded, data);
	}

	{
		const negative: p.InferInput<typeof p.Duration> = {
			seconds: -30n,
			nanos: -500000000,
		};

		const encoded = p.encode(p.Duration, negative);
		const decoded = p.decode(p.Duration, encoded);

		assertEquals(decoded, negative);
	}
});

Deno.test('Any type', () => {
	{
		const messageSchema = p.message({ value: p.string() }, { value: 1 });

		const data = {
			typeUrl: 'type.googleapis.com/test.Message',
			value: p.encode(messageSchema, { value: 'hello world' }),
		};

		const encoded = p.encode(p.Any, data);
		const decoded = p.decode(p.Any, encoded);

		assertEquals(decoded, data);
	}

	{
		const encoded = p.encode(p.Any, {});
		const decoded = p.decode(p.Any, encoded);

		assertEquals(decoded, { typeUrl: '', value: new Uint8Array(0) });
	}
});

// #endregion

// #region Edge cases

Deno.test('large varint values', () => {
	const Message = p.message({ value: p.int32() }, { value: 1 });

	// Test values that require multiple bytes in varint encoding
	const cases = [
		127, // 1 byte
		128, // 2 bytes
		16383, // 2 bytes
		16384, // 3 bytes
		2097151, // 3 bytes
		2097152, // 4 bytes
	];

	for (const value of cases) {
		const encoded = p.encode(Message, { value });
		const decoded = p.decode(Message, encoded);

		assertEquals(decoded, { value });
	}
});

Deno.test('very large varint handling', () => {
	const schema = p.message({ value: p.int32() }, { value: 1 });

	// Create a very large varint that would overflow 32-bit int
	// This represents 0xFFFFFFFF (4294967295) which should become -1 when cast to int32
	const largeVarintData = Uint8Array.from([
		8,
		0xFF,
		0xFF,
		0xFF,
		0xFF,
		0x0F, // field 1: max uint32 value
	]);

	const decoded = p.decode(schema, largeVarintData);
	assertEquals(decoded, { value: -1 }); // Should wrap around to -1
});

Deno.test('unknown field handling', () => {
	const Message = p.message({ known: p.string() }, { known: 1 });

	const buffer = Uint8Array.from([
		10,
		5,
		72,
		101,
		108,
		108,
		111, // field 1: "Hello"
		18,
		4,
		116,
		101,
		115,
		116, // field 2: "test" (unknown)
		26,
		3,
		98,
		121,
		101, // field 3: "bye" (unknown)
	]);

	const decoded = p.decode(Message, buffer);

	assertEquals(decoded, { known: 'Hello' });
});

Deno.test('duplicate field handling', () => {
	const Message = p.message({ value: p.int32() }, { value: 1 });

	const buffer = Uint8Array.from([
		8,
		42, // field 1: value 42
		8,
		24, // field 1: value 24 (duplicate)
	]);

	const decoded = p.decode(Message, buffer);

	assertEquals(decoded, { value: 24 });
});

Deno.test('encoding produces correct wire format', () => {
	// Test that our encoding matches expected protobuf wire format
	const schema = p.message({
		a: p.int32(),
		b: p.string(),
	}, {
		a: 1,
		b: 2,
	});

	const encoded = p.encode(schema, { a: 150, b: 'testing' });

	// Manual verification of wire format:
	// Field 1 (a=150): tag=1<<3|0=8, value=150 (varint) = [8, 150, 1]
	// Field 2 (b="testing"): tag=2<<3|2=18, length=7, "testing" = [18, 7, 116, 101, 115, 116, 105, 110, 103]

	const expected = Uint8Array.from([
		8,
		150,
		1, // field 1: int32 value 150
		18,
		7,
		116,
		101,
		115,
		116,
		105,
		110,
		103, // field 2: string "testing"
	]);

	assertEquals(encoded, expected);
});

// #endregion

// #region Input validation errors

Deno.test('type validation errors during encoding', () => {
	const StringMessage = p.message({ text: p.string() }, { text: 1 });
	{
		// @ts-expect-error: purposeful type error
		const result = p.tryEncode(StringMessage, 123);

		assert(!result.ok);
		assertEquals(result.message, `invalid_type at . (expected object)`);
	}

	{
		// @ts-expect-error: purposeful type error
		const result = p.tryEncode(StringMessage, { text: 123 });

		assert(!result.ok);
		assertEquals(result.message, `invalid_type at .text (expected string)`);
	}

	const Int64Message = p.message({ value: p.int64() }, { value: 1 });
	{
		// @ts-expect-error: purposeful type error
		const result = p.tryEncode(Int64Message, { value: 123 });

		assert(!result.ok);
		assertEquals(result.message, `invalid_type at .value (expected bigint)`);
	}

	const Uint64Message = p.message({ value: p.uint64() }, { value: 1 });
	{
		// @ts-expect-error: purposeful type error
		const result = p.tryEncode(Uint64Message, { value: 123 });

		assert(!result.ok);
		assertEquals(result.message, `invalid_type at .value (expected bigint)`);
	}
});

Deno.test('range validation for unsigned types', () => {
	const Uint32Message = p.message({ value: p.uint32() }, { value: 1 });
	const Uint64Message = p.message({ value: p.uint64() }, { value: 1 });
	const Fixed32Message = p.message({ value: p.fixed32() }, { value: 1 });
	const Fixed64Message = p.message({ value: p.fixed64() }, { value: 1 });

	// uint32 range errors
	assertThrows(() => p.encode(Uint32Message, { value: -1 }), p.ProtobufError);
	assertThrows(() => p.encode(Uint32Message, { value: 4294967296 }), p.ProtobufError);

	// uint64 range errors
	assertThrows(() => p.encode(Uint64Message, { value: -1n }), p.ProtobufError);

	// fixed32 range errors
	assertThrows(() => p.encode(Fixed32Message, { value: -1 }), p.ProtobufError);
	assertThrows(() => p.encode(Fixed32Message, { value: 4294967296 }), p.ProtobufError);

	// fixed64 range errors
	assertThrows(() => p.encode(Fixed64Message, { value: -1n }), p.ProtobufError);
});

// #endregion

// #region Decoding validation errors

Deno.test('invalid wire type handling', () => {
	const Message = p.message({ text: p.string() }, { text: 1 });

	// Manually create invalid wire data: field 1 with wire type 0 (varint) instead of 2 (length-delimited)
	const invalidData = Uint8Array.from([
		8,
		72, // field 1, wire type 0, value 72
	]);

	assertThrows(() => p.decode(Message, invalidData), p.ProtobufError);

	const result = p.tryDecode(Message, invalidData);
	assert(!result.ok);

	assertEquals(result.issues.length, 1);
	const issue = result.issues[0];

	assertEquals(issue.code, 'invalid_wire');
	assertEquals(issue.path, ['text']);

	if (issue.code === 'invalid_wire') {
		assertEquals(issue.expected, 2); // string expects wire type 2
	}

	assertStringIncludes(result.message, 'invalid_wire at');
	assertStringIncludes(result.message, 'expected wire type');
	assertStringIncludes(result.message, 'text');
});

Deno.test('multiple validation errors', () => {
	const Message = p.message({
		field1: p.string(),
		field2: p.int32(),
		field3: p.bytes(),
	}, {
		field1: 1,
		field2: 2,
		field3: 3,
	});

	// Create data with wrong wire types for multiple fields
	const invalidData = Uint8Array.from([
		8,
		72, // field 1, wire type 0 instead of 2
		18,
		1,
		65, // field 2, wire type 2 instead of 0
		24,
		100, // field 3, wire type 0 instead of 2
	]);

	const result = p.tryDecode(Message, invalidData);
	assert(!result.ok);

	assertEquals(result.message, 'invalid_wire at .field1 (expected wire type 2)');
});

Deno.test('missing required fields during decoding', () => {
	const Message = p.message({
		required1: p.string(),
		optional: p.optional(p.string()),
	}, {
		required1: 1,
		required2: 2,
		optional: 3,
	});

	// Create a message missing required fields
	const partialSchema = p.message({
		optional: p.optional(p.string()),
	}, {
		optional: 3,
	});

	const encoded = p.encode(partialSchema, { optional: 'hello' });

	const result = p.tryDecode(Message, encoded);
	assert(!result.ok);
	assertEquals(result.message, 'missing_value at .required1 (required field is missing)');
});

Deno.test('empty buffer handling', () => {
	const Message = p.message({
		required: p.string(),
		optional: p.optional(p.string()),
	}, {
		required: 1,
		optional: 2,
	});

	const emptyBuffer = new Uint8Array(0);

	const result = p.tryDecode(Message, emptyBuffer);
	assert(!result.ok);

	assertEquals(result.issues.length, 1);
	assertEquals(result.issues[0].code, 'missing_value');
	assertEquals(result.issues[0].path, ['required']);
});

// #endregion

// #region Buffer corruption and underrun

Deno.test('corrupted data handling', () => {
	const Message = p.message({ text: p.string() }, { text: 1 });

	// Test with truncated data (incomplete varint)
	const truncatedData = Uint8Array.from([10, 5, 72, 101]); // says length 5 but only has 2 bytes

	assertThrows(() => p.decode(Message, truncatedData));
});

Deno.test('buffer underrun during decoding', () => {
	const Message = p.message({ text: p.string() }, { text: 1 });

	// Create a truncated buffer that claims to have more data than it actually has
	// Wire format: tag (8=field 1, wire type 2) + length (5) + partial data (only 2 bytes instead of 5)
	const truncatedBuffer = Uint8Array.from([
		8 | 2, // tag: field 1, wire type 2 (length-delimited)
		5, // length: claims 5 bytes follow
		65,
		66, // only 2 bytes: "AB"
		// missing 3 bytes!
	]);

	const result = p.tryDecode(Message, truncatedBuffer);

	assert(!result.ok);
	assertEquals(result.message, `unexpected_eof at .text (unexpected end of input)`);
});

Deno.test('buffer underrun during varint reading', () => {
	const Message = p.message({ value: p.int32() }, { value: 1 });

	// Create a buffer with incomplete varint (continuation bit set but no more bytes)
	const incompleteVarint = Uint8Array.from([
		8, // tag: field 1, wire type 0 (varint)
		0x80, // varint with continuation bit set, but no more bytes
	]);

	const result = p.tryDecode(Message, incompleteVarint);

	assert(!result.ok);
	assertEquals(result.message, `unexpected_eof at .value (unexpected end of input)`);
});

// #endregion

// #region Performance tests

Deno.test('round-trip consistency stress test', () => {
	const Message = p.message({
		id: p.int64(),
		name: p.string(),
		email: p.optional(p.string()),
		tags: p.repeated(p.string()),
		metadata: p.bytes(),
		score: p.double(),
		active: p.boolean(),
	}, {
		id: 1,
		name: 2,
		email: 3,
		tags: 4,
		metadata: 5,
		score: 6,
		active: 7,
	});

	// Generate random test data
	for (let i = 0; i < 100; i++) {
		const data = {
			id: BigInt(Math.floor(Math.random() * 1000000)),
			name: `user_${i}`,
			email: Math.random() > 0.5 ? `user_${i}@example.com` : undefined,
			tags: Array.from({ length: Math.floor(Math.random() * 5) }, (_, j) => `tag_${j}`),
			metadata: new Uint8Array(
				Array.from({ length: Math.floor(Math.random() * 20) }, () => Math.floor(Math.random() * 255)),
			),
			score: Math.random() * 100,
			active: Math.random() > 0.5,
		};

		const encoded = p.encode(Message, data);
		const decoded = p.decode(Message, encoded);

		// `assertEquals` throws if properties aren't present entirely.
		decoded.email ??= undefined;

		assertEquals(decoded, data, `Failed for iteration ${i}`);
	}
});

Deno.test('very large arrays', () => {
	const strings = Array.from({ length: 10000 }, () => nanoid(8));

	{
		const Message = p.message({ strings: p.repeated(p.string(), false) }, { strings: 1 });

		const encoded = p.encode(Message, { strings });
		const decoded = p.decode(Message, encoded);

		assertEquals(decoded, { strings });
	}

	{
		const Message = p.message({ strings: p.repeated(p.string(), true) }, { strings: 1 });

		const encoded = p.encode(Message, { strings });
		const decoded = p.decode(Message, encoded);

		assertEquals(decoded, { strings });
	}
});

Deno.test('large string handling', () => {
	const Message = p.message({ text: p.string() }, { text: 1 });

	const text = nanoid(1048576);

	const encoded = p.encode(Message, { text });
	const decoded = p.decode(Message, encoded);

	assertEquals(decoded, { text });
});

Deno.test('large byte array handling', () => {
	const Message = p.message({ data: p.bytes() }, { data: 1 });

	const data = new Uint8Array(1024 * 1024);
	for (let i = 0; i < data.length; i++) {
		data[i] = Math.floor(Math.random() * 255);
	}

	const encoded = p.encode(Message, { data });
	const decoded = p.decode(Message, encoded);

	assertEquals(decoded, { data });
});

// #endregion
