export type BitSet = number | number[];

export const setBit = (bits: BitSet, index: number): BitSet => {
	if (typeof bits !== 'number') {
		const idx = index >> 5;

		for (let i = bits.length; i <= idx; i++) {
			bits.push(0);
		}

		bits[idx] |= 1 << index % 32;
		return bits;
	} else if (index < 32) {
		return bits | (1 << index);
	} else {
		return setBit([bits, 0], index);
	}
};

export const getBit = (bits: BitSet, index: number): number => {
	if (typeof bits === 'number') {
		return index < 32 ? (bits >>> index) & 1 : 0;
	} else {
		return (bits[index >> 5] >>> index % 32) & 1;
	}
};
