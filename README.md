# protobuf

protobuf codec with static type inference.

```typescript
import * as p from '@mary/protobuf';

// basic usage
{
	const Person = p.message({
		id: p.int64(),
		name: p.string(),
		email: p.optional(p.string()),
		tags: p.repeated(p.string()),
	}, {
		id: 1,
		name: 2,
		email: 3,
		tags: 4,
	});

	const person: p.InferInput<typeof Person> = {
		id: 123n,
		name: 'alice',
		email: 'alice@example.com',
		tags: ['developer', 'rust'],
	};

	const encoded = p.encode(Person, person);
	const decoded = p.decode(Person, encoded);
	//    ^? p.InferOutput<typeof Person>

	const result = p.tryDecode(Person, buffer);

	if (result.ok) {
		result.value;
	} else {
		result.message;
		result.issues;
	}
}

// nested and self-referential messages
{
	const Address = p.message({
		street: p.string(),
		city: p.string(),
		zipCode: p.optional(p.string()),
	}, {
		street: 1,
		city: 2,
		zipCode: 3,
	});

	const Place = p.message({
		name: p.string(),
		address: Address,
	}, {
		name: 1,
		address: 2,
	});

	const Node = p.message({
		value: p.int32(),
		get next() {
			return p.optional(Node);
		},
	}, {
		value: 1,
		next: 2,
	});
}

// maps
{
	const Scoreboard = p.message({
		scores: p.map(p.string(), p.int32()),
	}, {
		scores: 1,
	});

	const data: p.InferInput<typeof Scoreboard> = {
		scores: new Map([['alice', 100], ['bob', 95]]),
	};
}
```

## non-features

- **enums support**: use `int32()` instead for open enums
- **oneof support**: complicated, breaks self-referential messages
- **extensions support**: not supported
- **groups support**: use nested messages instead
- **code generation**: no intent
