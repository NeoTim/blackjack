// This file is part of Blackjack, a blackjack calculator and game.
//
// Copyright (C) 2015 Chen-Pang He <http://jdh8.org/>
//
// Integration by me is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// Integration by me is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

/**
 * The memory {@link heap} is altered from its beginning.  Its layout is as
 * follows.
 *
 * {double} [   0, 2240) - Expectancy to hit or stand
 * {double} [2240, 4400) - Expectancy to double
 * {double} [4400, 5200) - Expectancy to split
 * {int16}  [5200, 5256) - Bitset recording whether to hit or to stand
 * {int32}  [5256, 7752) - State of MT19937
 * {int8}   [7752,     ) - Decks for real game
 *
 * @summary Blackjack calculator in asm.js
 *
 * @param {Object}      stdlib  - JavaScript library
 * @param {Object}      foreign - Unused
 * @param {ArrayBuffer} heap    - Memory to be altered
 *
 * @returns {Object<function(...number)>}  Hash of the exported functions
 */
function Blackjack(stdlib, foreign, heap)
{
	"use asm";
	/**
	 * @constant
	 * @function
	 *
	 * @alias Math.imul
	 *
	 * @summary 32-bit integer multiplication
	 *
	 * @param {int} x - Multiplicand
	 * @param {int} y - Multiplier
	 *
	 * @returns {number}  Product of {@link x} and {@link y}
	 */
	var imul = stdlib.Math.imul;

	/**
	 * @constant
	 * @function
	 *
	 * @alias Math.max
	 *
	 * @summary Get the greatest parameter
	 *
	 * @param {...number} values - Numbers to compare
	 *
	 * @returns {number}  Greatest parameter
	 */
	var max = stdlib.Math.max;

	/**
	 * @constant {Float64Array}
	 * @summary The heap as an array of doubles
	 */
	var HEAPF64 = new stdlib.Float64Array(heap);

	/**
	 * @constant {Int32Array}
	 * @summary The heap as an array of 32-bit integers
	 */
	var HEAP32 = new stdlib.Int32Array(heap);

	/**
	 * @constant {Int16Array}
	 * @summary The heap as an array of 16-bit integers
	 */
	var HEAP16 = new stdlib.Int16Array(heap);

	/**
	 * @constant {Int8Array}
	 * @summary The heap as an array of 8-bit integers
	 */
	var HEAP8 = new stdlib.Int8Array(heap);

	/** @summary Probability of drawing a large card (10-A) */
	var pLarge = 0.0;

	/** @summary Probability of drawing a small card (2-6) */
	var pSmall = 0.0;

	/** @summary Pointer to current Mersenne Twister state */
	var mtstate = 0;

	/** @summary Pointer to past-the-end of decks */
	var endCard = 7752;

	/**
	 * The cards on the table are [{@link Blackjack~firstCard},
	 * {@link Blackjack~nextCard}).
	 *
	 * @summary Pointer to the first card on table
	 *
	 * @see {@link Blackjack~nextCard}
	 */
	var firstCard = 7752;

	/*
	 * The cards on the table are [{@link Blackjack~firstCard},
	 * {@link Blackjack~nextCard}).
	 *
	 * @summary Pointer to the next card to deal
	 *
	 * @see {@link Blackjack~firstCard}
	 */
	var nextCard = 7752;

	/**
	 * @summary Fill consecutive doubles in [begin, end) with {@link value}
	 *
	 * @param {int}    begin - Begin of array
	 * @param {int}    end   - End of array
	 * @param {double} value - Filled value
	 */
	function dfill(begin, end, value)
	{
		begin = begin|0;
		end = end|0;
		value = +value;

		for (; (begin|0) < (end|0); begin = begin + 8 |0)
			HEAPF64[begin >> 3] = value;
	}

	/**
	 * @summary Copy [begin, end) to {@link output} as doubles
	 *
	 * @param {int} begin  - Begin of array
	 * @param {int} end    - End of array
	 * @param {int} output - Pointer to destination
	 */
	function dcopy(begin, end, output)
	{
		begin = begin|0;
		end = end|0;
		output = output|0;

		for (; (begin|0) < (end|0); begin = begin + 8 |0)
		{
			HEAPF64[output >> 3] = HEAPF64[begin >> 3];
			output = output + 8 |0;
		}
	}

	/**
	 * The vector {@link x} is both read and written.
	 *
	 * @summary Compute {@link x} *= {@link a}
	 *
	 * @param {int}    n - Dimension of the vectors
	 * @param {double} a - Constant multiplier <var>a</var>
	 * @param {int}    x - Pointer to vector <var>x</var>
	 */
	function dscal(n, a, x)
	{
		n = n|0;
		a = +a;
		x = x|0;

		// The index is unused in body, so it can run backwards.
		for (; (n|0) >= 0; n = n - 1 |0)
		{
			HEAPF64[x >> 3] = a * HEAPF64[x >> 3];

			x = x + 8 |0;
		}
	}

	/**
	 * This function computes coefficient-wise {@link y} =
	 * {@link Math.max}({@link x}, {@link y}).  The returned bitset is
	 * coefficient-wise {@link x} > {@link y}.
	 *
	 * @summary Compare vectors
	 *
	 * @param {int} n - Entries to compare
	 * @param {int} x - Lhs vector
	 * @param {int} y - Rhs vector, overwritten with the greater coefficients
	 *
	 * @returns {signed}  Bitset of {@link x} > {@link y}
	 */
	function dmax(n, x, y)
	{
		n = n|0;
		x = x|0;
		y = y|0;

		/** @summary Returned bitset */
		var bitset = 0;

		/**
		 * Becuase the index is used in body and the loop runs forwards, an
		 * additional variable for loop index is needed.
		 *
		 * @summary Loop index
		 */
		var k = 0;

		for (; (k|0) < (n|0); k = k + 1 |0)
		{
			if (+HEAPF64[y >> 3] < +HEAPF64[x >> 3])
			{
				HEAPF64[y >> 3] = HEAPF64[x >> 3];
				bitset = 1 << k | bitset;
			}

			x = x + 8 |0;
			y = y + 8 |0;
		}

		return bitset|0;
	}

	/**
	 * The vector {@link y} is both read and written.
	 *
	 * @summary Compute {@link y} += {@link a} * {@link x}
	 *
	 * @param {int}    n - Dimension of the vectors
	 * @param {double} a - Constant multiplier <var>a</var>
	 * @param {int}    x - Pointer to vector <var>x</var>
	 * @param {int}    y - Pointer to vector <var>y</var>
	 *
	 * @see Blackjack~daxpy
	 * @see Blackjack~daxpyDouble
	 */
	function daxpySimple(n, a, x, y)
	{
		n = n|0;
		a = +a;
		x = x|0;
		y = y|0;

		// The index is unused in body, so it can run backwards.
		for (; (n|0) >= 0; n = n - 1 |0)
		{
			HEAPF64[y >> 3] = a * HEAPF64[x >> 3] + HEAPF64[y >> 3];

			x = x + 8 |0;
			y = y + 8 |0;
		}
	}

	/**
	 * Similar to {@link Blackjack~daxpySimple} but allowing strides other than
	 * 1.  Vectorization may be disabled here.
	 *
	 * @summary Compute {@link y} += {@link a} * {@link x}
	 *
	 * @param {int}    n    - Dimension of the vectors
	 * @param {double} a    - Constant multiplier <var>a</var>
	 * @param {int}    x    - Pointer to vector <var>x</var>
	 * @param {int}    incx - Stride of {@link x}
	 * @param {int}    y    - Pointer to vector <var>y</var>
	 * @param {int}    incy - Stride of {@link y}
	 */
	function daxpy(n, a, x, incx, y, incy)
	{
		n = n|0;
		a = +a;
		x = x|0;
		incx = incx|0;
		y = y|0;
		incy = incy|0;

		// The index is unused in body, so it can run backwards.
		for (; (n|0) >= 0; n = n - 1 |0)
		{
			HEAPF64[y >> 3] = a * HEAPF64[x >> 3] + HEAPF64[y >> 3];

			x = x + (incx << 3) |0;
			y = y + (incy << 3) |0;
		}
	}

	/**
	 * The probabilities are initialized in {@link run}.
	 *
	 * @summary Probability of drawing a specific card
	 */
	function p(card)
	{
		card = card|0;

		switch (card|0)
		{
			case 1:
			case 10:
			case 11:
				return +pLarge;
			case 7:
			case 8:
			case 9:
				return 1.0 / 13.0;
		}

		return +pSmall;
	}

	/**
	 * @summary Backwards iterate on cards [1, {@link card}]
	 *
	 * @param {int} n    - Stride in sizeof(double)
	 * @param {int} card - Starting card
	 * @param {int} src  - Reading pointer at start
	 * @param {int} dst  - Writing pointer
	 */
	function countdown(n, card, src, dst)
	{
		n = n|0;
		card = card|0;
		src = src|0;
		dst = dst|0;

		for (; card; card = card - 1 |0)
		{
			daxpySimple(n, +p(card), src, dst);
			src = src - (n << 3) |0;
		}
	}

	/**
	 * @summary Forwards iterate on cards [{@link begin}, {@link end})
	 *
	 * @param {int} n     - Stride in sizeof(double)
	 * @param {int} begin - Starting card (counted)
	 * @param {int} end   - Ending card (not counted)
	 * @param {int} src   - Reading pointer at start
	 * @param {int} dst   - Writing pointer
	 */
	function countup(n, begin, end, src, dst)
	{
		n = n|0;
		begin = begin|0;
		end = end|0;
		src = src|0;
		dst = dst|0;

		for (; (begin|0) < (end|0); begin = begin + 1 |0)
		{
			daxpySimple(n, +p(begin), src, dst);
			src = src + (n << 3) |0;
		}
	}

	/**
	 * This function writes {@link heap} as follows.
	 *
	 * {double} [  0,  400) - Result table
	 * {double} [400, 1520) - Temporary storage
	 *
	 * Rows are stored as 2-A.  Each row contains probabilities to stop at
	 * 17-21, excluding blackjacks.  Probability of blackjack can be easily
	 * computed from {@link Blackjack~pLarge}, thus discarded.
	 *
	 * @summary Compute dealer's non-blackjack non-busted probabilities
	 *
	 * @param {int} options - Settings
	 *
	 * @see Blackjack~Player
	 */
	function Dealer(options)
	{
		options = options|0;

		// Temporary memory layout:
		//
		// [ 400, 1120) - Hard  4-21
		// [1120, 1520) - Soft 12-21
		//
		// Each row contains [p(17), p(18), p(19), p(20), p(21)].  As each row
		// has 40 bytes, pointer to a hard row is ((points + 6) * 40), soft
		// row ((points + 16) * 40).

		/** @summary Writing pointer to vector */
		var v = 0;

		/** @summary Dealt points */
		var dealt = 16;

		// Initialize each row to null vector to start accumulation
		dfill(0, 1520, 0.0);

		/* Build temporary tables */

		HEAPF64[115] = 1.0;
		HEAPF64[121] = 1.0;
		HEAPF64[127] = 1.0;
		HEAPF64[133] = 1.0;
		HEAPF64[139] = 1.0;

		// Hard 16 to 11
		v = 880;

		for (; (dealt|0) >= 11; dealt = dealt - 1 |0)
		{
			countdown(5, 21 - dealt |0, 1080, v);
			v = v - 40 |0;
		}

		// Soft 21 to 12
		HEAPF64[171] = 1.0;
		HEAPF64[177] = 1.0;
		HEAPF64[183] = 1.0;
		HEAPF64[189] = 1.0;

		if (options & 4)
		{
			v = 1320;
			dealt = 17;
		}
		else
		{
			HEAPF64[165] = 1.0;
			v = 1280;
			dealt = 16;
		}

		for (; (dealt|0) >= 12; dealt = dealt - 1 |0)
		{
			countdown(5, 21 - dealt |0, 1480, v);
			countup(5, 22 - dealt |0, 11, 720, v);
			v = v - 40 |0;
		}

		// Hard 10 to 4
		for (v = 640; (v|0) >= 400; v = v - 40 |0)
		{
			countup(5, 2, 11, v + 80 |0, v);
			daxpySimple(5, pLarge, v + 840 |0, v);
		}

		/* Build result */

		// Up 2-10, hole non-A
		for (v = 0; (v|0) < 360; v = v + 40 |0)
			countup(5, 2, 11, v + 400 |0, v);

		// Up 2-9, hole A
		for (v = 0; (v|0) < 320; v = v + 40 |0)
			daxpySimple(5, pLarge, v + 1160 |0, v);

		// Up A, hole non-10
		countup(5, 1, 10, 1120, 360);

		// Exclude dealer-shown blackjacks
		if (options & 8)
		{
			dscal(5, 1.0 / (1.0 - pLarge)      , 320);
			dscal(5, 1.0 / (1.0 - pLarge * 4.0), 360);
		}
	}

	/**
	 * This function reads and writes {@link heap} as follows.
	 *
	 * Read then overwritten:
	 *
	 * {double} [   0,  400) - Dealer's non-blackjack non-busted probabilities
	 *
	 * Written:
	 *
	 * {double} [   0, 1440) - Table of E(stand), hard  4-21
	 * {double} [1440, 2240) - Table of E(stand), soft 12-21
	 *
	 * Each row contains expectancies against up card 2-A, taking 80 bytes.
	 * Pointer to a hard row is ((points - 4) * 80), soft row
	 * ((points + 6) * 80).
	 *
	 * @summary Compute player's expectancy to stand
	 *
	 * @param {int} options - Settings
	 *
	 * @see Blackjack~Player
	 */
	function stand(options)
	{
		options = options|0;

		/** @summary Reading pointer to vector */
		var x = 32; // Vector of p(21) with stride 5

		/** @summary Writing pointer to vector */
		var y = 1280;

		// E(21) = 1 - p(21) - 2 * p(blackjack)
		dfill(1360, 1440, 1.0);
		daxpy(10, -1.0, 32, 5, 1360, 1);

		if (options & 8)
		{
			HEAPF64[178] = HEAPF64[178] - pLarge * 2.0;
			HEAPF64[179] = HEAPF64[179] - pLarge * 8.0;
		}

		// For 16 < n < 21, E(n-1) = E(n) - p(n) - p(n-1)
		for (; (y|0) >= 960; y = y - 80 |0)
		{
			dcopy(y + 80 |0, y + 160 |0, y);
			daxpy(10, -1.0, x, 5, y, 1);
			x = x - 8 |0;
			daxpy(10, -1.0, x, 5, y, 1);
		}

		// For n < 16, E(n) = E(16)
		dcopy(960, 1040, 880);
		dcopy(880, 1040, 720);
		dcopy(720, 1040, 400);
		dcopy(640, 1040,   0);

		// E(soft) = E(hard)
		dcopy(640, 1440, 1440);
	}

	/**
	 * This function reads and writes {@link heap} as follows.
	 *
	 * Read:
	 *
	 * {double} [1440, 2240) - Table of E(stand), 12-21
	 *
	 * Written:
	 *
	 * {double} [2240, 3600) - Table of E(double), hard  4-20
	 * {double} [3600, 4400) - Table of E(double), soft 12-21
	 *
	 * Each row contains expectancies against up card 2-A, taking 80 bytes.
	 * Pointer to a hard row is ((points + 24) * 80), soft row
	 * ((points + 33) * 80).
	 *
	 * @summary Compute player's expectancy to double
	 *
	 * @see Blackjack~Player
	 */
	function doubledown()
	{
		/** @summary Expectancy contributed by bust, i.e. -p(bust) */
		var eBust = -1.0;

		/** @summary Writing pointer to vector */
		var v = 3520;

		/** @summary Dealt points */
		var dealt = 20;

		// Hard 20 to 11
		for (; (dealt|0) >= 11; dealt = dealt - 1 |0)
		{
			eBust = eBust + +p(21 - dealt |0);
			dfill(v, v + 80 |0, eBust);
			countdown(10, 21 - dealt |0, 2160, v);
			v = v - 80 |0;
		}

		// Hard 10 to 4
		dfill(2240, 2800, 0.0);

		for (; (dealt|0) >= 4; dealt = dealt - 1 |0)
		{
			countup(10, 2, 12, v - 160 |0, v);
			v = v - 80 |0;
		}

		// Soft 21 to 12
		v = 4320;

		for (dealt = 21; (dealt|0) >= 12; dealt = dealt - 1 |0)
		{
			countdown(10, 21 - dealt |0, 2160, v);
			countup(10, 22 - dealt |0, 11, 1440, v);
			v = v - 80 |0;
		}

		// Double elements to get the correct expectancy
		dscal(270, 2.0, 2240);
	}

	/**
	 * This function reads and writes {@link heap} as follows.
	 *
	 * Read then overwritten:
	 *
	 * {double} [   0, 2240) - Table of E(stand)
	 *
	 * Written:
	 *
	 * {double} [   0, 2240) - Table of E(stand or hit)
	 * {double} [5120, 5200) - Temporary storage
	 * {int16}  [5200, 5256) - Bitset recording whether to hit or to stand
	 *
	 * Each row contains expectancies against up card 2-A, taking 80 bytes.
	 * Pointer to a hard row is ((points - 4) * 80), soft row
	 * ((points + 6) * 80).
	 *
	 * Each bitset contains strategies against up card 2-A, taking 2 bytes.
	 * Pointer to a hard bitset is (points + 2596 << 1), soft bitset
	 * (points + 2606 << 1).
	 *
	 * @summary Compute player's expectancy to hit
	 *
	 * @see Blackjack~Player
	 */
	function hit()
	{
		/** @summary Expectancy contributed by bust, i.e. -p(bust) */
		var eBust = -1.0;

		/** @summary Writing pointer to bitset */
		var bitset = 5232;

		/** @summary Writing pointer to vector */
		var v = 1280;

		/** @summary Dealt points */
		var dealt = 0;

		// Hard 20 to 11
		for (dealt = 20; (dealt|0) >= 11; dealt = dealt - 1 |0)
		{
			eBust = eBust + +p(21 - dealt |0);

			dfill(5120, 5200, eBust);
			countdown(10, 21 - dealt |0, 1360, 5120);

			HEAP16[bitset >> 1] = dmax(10, 5120, v)|0;
			bitset = bitset - 2 |0;
			v = v - 80 |0;
		}

		// Soft 21 to 12
		bitset = 5254;
		v = 2160;

		for (dealt = 21; (dealt|0) >= 12; dealt = dealt - 1 |0)
		{
			dfill(5120, 5200, 0.0);
			countdown(10, 21 - dealt |0, 2160, 5120);
			countup(10, 22 - dealt |0, 11, 1440, 5120);

			HEAP16[bitset >> 1] = dmax(10, 5120, v)|0;
			bitset = bitset - 2 |0;
			v = v - 80 |0;
		}

		// Hard 10 to 4
		bitset = 5212;

		for (v = 480; (v|0) >= 0; v = v - 80 |0)
		{
			dfill(5120, 5200, 0.0);
			countup(10, 2, 12, v + 160 |0, 5120);
			daxpySimple(10, pLarge, v + 1680 |0, 5120);

			HEAP16[bitset >> 1] = dmax(10, 5120, v)|0;
			bitset = bitset - 2 |0;
		}
	}

	/**
	 * The vector {@link y} is both read and written.  The vector {@link x}
	 * must store E(stand or hit), and the vector <var>xx</var> storing
	 * E(double) is automatically found by pointer shift.
	 *
	 * @summary Compute {@link y} += {@link a} * {@link Math.max}({@link x},
	 *			<var>xx</var>).
	 *
	 * @param {int}    n - Dimension of the vectors
	 * @param {double} a - Constant multiplier <var>a</var>
	 * @param {int}    x - Pointer to hard vector <var>x</var>
	 * @param {int}    y - Pointer to vector <var>y</var>
	 *
	 * @see Blackjack~daxpy
	 * @see Blackjack~daxpyDouble
	 */
	function daxpyDouble(n, a, x, y)
	{
		n = n|0;
		a = +a;
		x = x|0;
		y = y|0;

		// The index is unused in body, so it can run backwards.
		for (; (n|0) >= 0; n = n - 1 |0)
		{
			HEAPF64[y >> 3] = a * max(HEAPF64[x >> 3], HEAPF64[x + 2240 >> 3])
								+ HEAPF64[y >> 3];
			x = x + 8 |0;
			y = y + 8 |0;
		}
	}

	/**
	 * This function uses {@link heap} as stated in {@link Blackjack~Split}.
	 *
	 * @summary Compute player's expectancy to split when resplit denyed
	 *
	 * @param {int} options - Settings
	 *
	 * @see Blackjack~resplit
	 */
	function lastSplit(options)
	{
		options = options|0;

		/** @summary Reading pointer to vector */
		var src = 0;

		/** @summary Writing pointer to vector */
		var dst = 0;

		/** @summary Dealt points */
		var dealt = 2;

		/** @summary Current card */
		var card = 0;

		for (; (dealt|0) < 11; dealt = dealt + 1 |0)
		{
			dst = src + 4400 |0;

			for (card = 2; (card|0) < 11; card = card + 1 |0)
			{
				decideDaxpy[options & 1](10, +p(card), src, dst);
				src = src + 80 |0;
			}

			decideDaxpy[options & 1](10, pLarge, src + 800 |0, dst);
			src = dst - 4320 |0;
		}

		countup(10, 1, 11, 1440, 5120);
	}

	/**
	 * This function uses {@link heap} as stated in {@link Blackjack~Split}.
	 *
	 * @summary Compute player's expectancy to split when resplit allowed
	 *
	 * @param {int} options - Settings
	 *
	 * @see Blackjack~lastSplit
	 */
	function resplit(options)
	{
		options = options|0;

		/** @summary Reading pointer to vector */
		var src = 0;

		/** @summary Writing pointer to vector */
		var dst = 0;

		/** @summary Dealt points */
		var dealt = 2;

		/** @summary Current card */
		var card = 0;

		for (; (dealt|0) < 11; dealt = dealt + 1 |0)
		{
			dst = src + 4400 |0;

			for (card = 2; (card|0) < 11; card = card + 1 |0)
			{
				if ((card|0) != (dealt|0))
				{
					decideDaxpy[options & 1](10, +p(card), src, dst);
					src = src + 80 |0;
				}
			}

			decideDaxpy[options & 1](10, pLarge, src + 800 |0, dst);
			dscal(10, 1.0 / (1.0 - +p(dealt)), dst);

			src = dst - 4320 |0;
		}

		countup(10, 1, 10, 1440, 5120);
		dscal(10, 1.0 / (1.0 - pLarge), 5120);
	}

	/**
	 * This function reads and writes {@link heap} as follows.
	 *
	 * Read:
	 *
	 * {double} [   0, 2240) - Table of E(stand or hit)
	 * {double} [2240, 4400) - Expectancy to double
	 * {int16}  [5200, 5256) - Bitset recording whether to hit or to stand
	 *
	 * Written:
	 *
	 * {double} [4400, 5200) - Expectancy to split
	 *
	 * Each row contains expectancies against up card 2-A, taking 80 bytes.
	 *
	 * @summary Compute player's expectancy to split
	 *
	 * @param {int} options - Settings
	 *
	 * @see Blackjack~Player
	 */
	function split(options)
	{
		options = options|0;

		decideSplit[options >> 1 & 1](options);
	}

	/**
	 * This function is exported, writing {@link heap} as follows.
	 *
	 * {double} [   0, 2240) - Expectancy to hit or stand
	 * {double} [2240, 4400) - Expectancy to double
	 * {double} [4400, 5200) - Expectancy to split
	 * {int16}  [5200, 5256) - Bitset recording whether to hit or to stand
	 *
	 * The flags of {@link options}:
	 *
	 * 1 - Allow double after split
	 * 2 - Allow resplit
	 * 4 - Dealer hits soft 17
	 * 8 - Dealer shows the hole card if blackjack
	 *
	 * @summary Find optimal strategy and its expectancy
	 *
	 * @param {int}    options - Settings
	 * @param {double} count   - True count in the Hi-Lo system
	 */
	function Player(options, count)
	{
		options = options|0;
		count = +count;

		pLarge = (10.0 - count) / 130.0;
		pSmall = (10.0 + count) / 130.0;

		Dealer(options);

		stand(options);
		doubledown();
		hit();
		split(options);
	}

	/**
	 * This function stores the state in {@link heap} as follows.
	 *
	 * {int32} [5256, 7752) - Table of state
	 *
	 * @summary Initialize MT19937, a random number generator
	 *
	 * @param {int} seed - Initial state of the generator
	 */
	function MT19937(seed)
	{
		seed = seed|0;

		var k = 1;

		mtstate = 5256;
		HEAP32[1314] = seed;

		for (; (k|0) <= 624; k = k + 1 |0)
		{
			seed = imul(seed ^ seed >> 30, 1812433253) + k |0;
			HEAP32[1314 + k << 2 >> 2] = seed;
		}
	}

	/**
	 * This function renews the state in {@link heap} as follows.
	 *
	 * {int32} [5256, 7752) - Table of state
	 *
	 * @summary Renew the table of state
	 */
	function twist()
	{
		var k = 0, x = 0;

		for (; (k|0) < 2496; k = k + 4 |0)
		{
			x = HEAP32[5256 + ((k + 4 |0) % 2496 |0) >> 2] & 0x7fffffff
				| HEAP32[5256 + k >> 2] & 0x80000000;

			HEAP32[5256 + k >> 2] = imul(x & 1, 0x9908b0df) ^ x >> 1
				^ HEAP32[5256 + ((k + 1588 |0) % 2496 |0) >> 2];
		}
	}

	/**
	 * This function reads the state in {@link heap} as follows.
	 *
	 * {int32} [5256, 7752) - Table of state
	 *
	 * @summary Extract the current random number
	 */
	function rand()
	{
		var x = 0;

		switch (mtstate|0)
		{
			case 0:
				MT19937(5489);
				break;
			case 7752:
				twist();
				mtstate = 5256;
		}

		x = HEAP32[mtstate >> 2]|0;
		x = x ^ x >> 11;
		x = x ^ x >>  7 & 0x9d2c5680;
		x = x ^ x >> 15 & 0xefc60000;
		x = x ^ x >> 18;

		mtstate = mtstate + 4 |0;

		return x|0;
	}

	/**
	 * @summary Copy [begin, end) to {@link output} as 32-bit integers
	 *
	 * @param {int} begin  - Begin of array
	 * @param {int} end    - End of array
	 * @param {int} output - Pointer to destination
	 */
	function icopy(begin, end, output)
	{
		begin = begin|0;
		end = end|0;
		output = output|0;

		for (; (begin|0) < (end|0); begin = begin + 4 |0)
		{
			HEAP32[output >> 2] = HEAP32[begin >> 2];
			output = output + 4 |0;
		}
	}

	/**
	 * @summary Swap 8-bit integers
	 *
	 * @param {int} x - Pointer whose content is to swap
	 * @param {int} y - Pointer whose content is to swap
	 */
	function swap8(x, y)
	{
		x = x|0;
		y = y|0;

		var tmp = 0;

		tmp = HEAP8[x]|0;
		HEAP8[x] = HEAP8[y];
		HEAP8[y] = tmp;
	}

	/**
	 * @summary Swap [begin, end) to {@link other} as 8-bit integers
	 *
	 * @param {int} begin - Begin of array
	 * @param {int} end   - End of array
	 * @param {int} other - Pointer to destination
	 */
	function swapString(begin, end, other)
	{
		begin = begin|0;
		end = end|0;
		other = other|0;

		for (; (begin|0) < (end|0); begin = begin + 1 |0)
		{
			swap8(begin, other);
			other = other + 1 |0;
		}
	}

	/**
	 * The cards to shuffle are all cards not in play, i.e. in
	 * [7752, {@link Blackjack~endCard}) excluding
	 * [{@link Blackjack~firstCard}, {@link Blackjack~nextCard}).
	 *
	 * @summary Shuffle the cards in decks
	 *
	 * @see Blackjack~Shoe
	 */
	function shuffle()
	{
		/** @summary Remaining cards to shuffle */
		var cards = 0;

		swapString(firstCard, nextCard, 7752);

		firstCard = 7752;
		nextCard = nextCard - firstCard + 7752 |0;

		for (cards = endCard - nextCard |0; cards; cards = cards - 1 |0)
			swap8(nextCard + cards |0, nextCard + ((rand()|0) % (cards|0)|0)|0);
	}

	/**
	 * Variables {@link Blackjack~endCard}, {@link Blackjack~firstCard},
	 * {@link Blackjack~nextCard}, and {@link heap} segment
	 * [7752, {@link Blackjack~endCard}) are written to reflect card change.
	 *
	 * @summary Create decks of cards and shuffle them
	 *
	 * @param {int} decks - Number of decks
	 */
	function Shoe(decks)
	{
		decks = decks|0;

		var k = 0;

		endCard = 7752 + imul(decks, 52) |0;

		for (k = 0; (k|0) < 52; k = k + 1 |0)
			HEAP8[7752 + k |0] = k;

		for (k = 5308; (k|0) < (endCard|0); k = k + 52 |0)
			icopy(7752, 7804, k);

		shuffle();
	}

	/**
	 * @summary Find the correct implementation of splitted daxpy.
	 *
	 * @see Blackjack~daxpySimple
	 * @see Blackjack~daxpyDouble
	 */
	var decideDaxpy = [daxpySimple, daxpyDouble];

	/**
	 * @summary Find the correct implementation of {@link Blackjack~Split}.
	 *
	 * @see Blackjack~lastSplit
	 * @see Blackjack~resplit
	 */
	var decideSplit = [lastSplit, resplit];

	return {
		expectancy: Player,
		decks: Shoe,
	};
}
