//! 256-bit intermediates for Q64.64 arithmetic.
//!
//! Only what the AMM needs: a full 128x128 product, shifts, and a
//! 256-by-128 division. Hand-rolled rather than pulled from a crate so the
//! overflow semantics are ours and every path is unit-tested.

use crate::constants::{ONE_Q64, SCALE_OFFSET};
use crate::errors::{CoreError, Result};
use crate::require;

const MASK64: u128 = u64::MAX as u128;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct U256 {
    pub hi: u128,
    pub lo: u128,
}

impl U256 {
    pub const ZERO: U256 = U256 { hi: 0, lo: 0 };

    pub const fn from_u128(v: u128) -> Self {
        U256 { hi: 0, lo: v }
    }

    /// Full 128x128 -> 256 product. Cannot overflow.
    pub fn mul(a: u128, b: u128) -> Self {
        let (a0, a1) = (a & MASK64, a >> 64);
        let (b0, b1) = (b & MASK64, b >> 64);

        let p00 = a0 * b0;
        let p01 = a0 * b1;
        let p10 = a1 * b0;
        let p11 = a1 * b1;

        // (p01 + p10) is a 128-bit sum of two 128-bit values; its carry lands
        // at bit 128 and, once shifted left by 64, at bit 64 of `hi`.
        let (mid, carry) = p01.overflowing_add(p10);
        let mut hi = p11 + (mid >> 64) + if carry { 1u128 << 64 } else { 0 };
        let (lo, carry_lo) = p00.overflowing_add(mid << 64);
        if carry_lo {
            hi += 1;
        }
        U256 { hi, lo }
    }

    pub fn checked_add(self, rhs: U256) -> Result<U256> {
        let (lo, carry) = self.lo.overflowing_add(rhs.lo);
        let hi = self
            .hi
            .checked_add(rhs.hi)
            .and_then(|h| h.checked_add(u128::from(carry)))
            .ok_or(CoreError::MathOverflow)?;
        Ok(U256 { hi, lo })
    }

    pub fn checked_add_u128(self, rhs: u128) -> Result<U256> {
        self.checked_add(U256::from_u128(rhs))
    }

    pub fn shr(self, n: u32) -> Self {
        match n {
            0 => self,
            1..=127 => U256 {
                hi: self.hi >> n,
                lo: (self.lo >> n) | (self.hi << (128 - n)),
            },
            128 => U256 { hi: 0, lo: self.hi },
            129..=255 => U256 {
                hi: 0,
                lo: self.hi >> (n - 128),
            },
            _ => U256::ZERO,
        }
    }

    /// Narrow to `u128`, erroring if the high half carries anything.
    pub fn to_u128(self) -> Result<u128> {
        require!(self.hi == 0, CoreError::MathOverflow);
        Ok(self.lo)
    }

    #[inline]
    fn bit(&self, i: u32) -> u128 {
        if i >= 128 {
            (self.hi >> (i - 128)) & 1
        } else {
            (self.lo >> i) & 1
        }
    }

    /// `floor(self / d)`. Errors when `d` is zero, or when the quotient
    /// exceeds `u128` — the latter is how the ladder discovers it has run off
    /// the end of the representable price range.
    pub fn div_u128(self, d: u128) -> Result<u128> {
        require!(d != 0, CoreError::DivideByZero);
        if self.hi == 0 {
            return Ok(self.lo / d);
        }

        // Restoring long division. `rem` stays below `d`, so `rem << 1` can
        // carry out of `u128`; that carry is tracked explicitly and always
        // implies `rem >= d`, since `d <= u128::MAX`.
        //
        // Starting at the numerator's top set bit rather than at bit 255 is
        // worth doing: this loop is the most expensive thing the ladder can
        // run, and the leading half of a 256-bit word is usually all zeros.
        let mut rem: u128 = 0;
        let mut quo_hi: u128 = 0;
        let mut quo_lo: u128 = 0;
        let top = 255 - self.hi.leading_zeros();

        for i in (0..=top).rev() {
            let carry = rem >> 127 != 0;
            rem = (rem << 1) | self.bit(i);
            if carry || rem >= d {
                rem = rem.wrapping_sub(d);
                if i >= 128 {
                    quo_hi |= 1u128 << (i - 128);
                } else {
                    quo_lo |= 1u128 << i;
                }
            }
        }

        require!(quo_hi == 0, CoreError::MathOverflow);
        Ok(quo_lo)
    }

    /// `self / d`, rounded up.
    pub fn div_u128_ceil(self, d: u128) -> Result<u128> {
        require!(d != 0, CoreError::DivideByZero);
        self.checked_add_u128(d - 1)?.div_u128(d)
    }
}

/// `floor(a * b / denom)` with a 256-bit intermediate.
pub fn mul_div(a: u128, b: u128, denom: u128) -> Result<u128> {
    require!(denom != 0, CoreError::DivideByZero);
    match a.checked_mul(b) {
        Some(p) => Ok(p / denom),
        None => U256::mul(a, b).div_u128(denom),
    }
}

/// `a * b / denom`, rounded to nearest (ties up).
pub fn mul_div_round(a: u128, b: u128, denom: u128) -> Result<u128> {
    require!(denom != 0, CoreError::DivideByZero);
    U256::mul(a, b).checked_add_u128(denom / 2)?.div_u128(denom)
}

/// `a * b / denom`, rounded up.
pub fn mul_div_ceil(a: u128, b: u128, denom: u128) -> Result<u128> {
    require!(denom != 0, CoreError::DivideByZero);
    match a.checked_mul(b) {
        Some(p) => Ok(p.div_ceil(denom)),
        None => U256::mul(a, b).div_u128_ceil(denom),
    }
}

/// Q64.64 multiply: `floor(a * b / 2^64)`.
pub fn mul_q64(a: u128, b: u128) -> Result<u128> {
    U256::mul(a, b).shr(SCALE_OFFSET).to_u128()
}

/// Q64.64 multiply, rounded up.
pub fn mul_q64_ceil(a: u128, b: u128) -> Result<u128> {
    U256::mul(a, b).div_u128_ceil(ONE_Q64)
}

/// Q64.64 divide: `floor(a * 2^64 / b)`.
pub fn div_q64(a: u128, b: u128) -> Result<u128> {
    require!(b != 0, CoreError::DivideByZero);
    U256::mul(a, ONE_Q64).div_u128(b)
}

/// Q64.64 divide, rounded up.
pub fn div_q64_ceil(a: u128, b: u128) -> Result<u128> {
    require!(b != 0, CoreError::DivideByZero);
    U256::mul(a, ONE_Q64).div_u128_ceil(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mul_matches_u128_when_it_fits() {
        let cases: [(u128, u128); 4] = [
            (0, 0),
            (1, 1),
            (u64::MAX as u128, u64::MAX as u128),
            (12345, 987654321),
        ];
        for (a, b) in cases {
            let w = U256::mul(a, b);
            assert_eq!(w.hi, 0);
            assert_eq!(w.lo, a * b);
        }
    }

    #[test]
    fn mul_max_operands() {
        // (2^128 - 1)^2 == 2^256 - 2^129 + 1
        let w = U256::mul(u128::MAX, u128::MAX);
        assert_eq!(w.hi, u128::MAX - 1);
        assert_eq!(w.lo, 1);
    }

    #[test]
    fn mul_carries_across_the_midpoint() {
        // (2^127 + 1)^2 == 2^254 + 2^128 + 1
        let a = (1u128 << 127) | 1;
        let w = U256::mul(a, a);
        assert_eq!(w.hi, (1u128 << 126) + 1);
        assert_eq!(w.lo, 1);
    }

    #[test]
    fn div_is_the_exact_floor() {
        // Divisors are large enough that a*2^64/d still fits u128.
        let cases: [(u128, u128); 5] = [
            (u128::MAX, u128::MAX / 7),
            (1u128 << 100, 1u128 << 40),
            (12345678901234567890, 1u128 << 70),
            (u128::MAX, u128::MAX),
            (0, 5),
        ];
        for (a, d) in cases {
            let num = U256::mul(a, ONE_Q64);
            let q = num.div_u128(d).unwrap();
            // q*d <= num < (q+1)*d
            let lower = U256::mul(q, d);
            let upper = U256::mul(q + 1, d);
            assert!(
                (lower.hi, lower.lo) <= (num.hi, num.lo),
                "lower bound for {a}/{d}"
            );
            assert!(
                (num.hi, num.lo) < (upper.hi, upper.lo),
                "upper bound for {a}/{d}"
            );
        }
    }

    #[test]
    fn div_errors_when_the_true_quotient_exceeds_u128() {
        // u128::MAX * 2^64 / 3 needs ~190 bits.
        assert!(U256::mul(u128::MAX, ONE_Q64).div_u128(3).is_err());
    }

    #[test]
    fn round_goes_to_nearest_with_ties_up() {
        assert_eq!(mul_div_round(5, 1, 2).unwrap(), 3); // 2.5 -> 3
        assert_eq!(mul_div_round(4, 1, 2).unwrap(), 2);
        assert_eq!(mul_div_round(7, 1, 3).unwrap(), 2); // 2.33 -> 2
        assert_eq!(mul_div_round(8, 1, 3).unwrap(), 3); // 2.67 -> 3
    }

    #[test]
    fn div_detects_quotient_overflow() {
        // 2^255 / 2 == 2^254, which does not fit u128.
        let w = U256 {
            hi: 1u128 << 127,
            lo: 0,
        };
        assert!(w.div_u128(2).is_err());
    }

    #[test]
    fn div_by_zero_errors() {
        assert!(U256::from_u128(1).div_u128(0).is_err());
        assert!(mul_div(1, 1, 0).is_err());
        assert!(div_q64(1, 0).is_err());
    }

    #[test]
    fn q64_identities() {
        assert_eq!(mul_q64(ONE_Q64, ONE_Q64).unwrap(), ONE_Q64);
        assert_eq!(div_q64(ONE_Q64, ONE_Q64).unwrap(), ONE_Q64);
        let two_and_a_half = ONE_Q64 * 5 / 2;
        assert_eq!(mul_q64(two_and_a_half, 4 * ONE_Q64).unwrap(), 10 * ONE_Q64);
        assert_eq!(div_q64(10 * ONE_Q64, 4 * ONE_Q64).unwrap(), two_and_a_half);
    }

    #[test]
    fn ceil_variants_round_up_only_on_a_remainder() {
        assert_eq!(mul_div(7, 1, 2).unwrap(), 3);
        assert_eq!(mul_div_ceil(7, 1, 2).unwrap(), 4);
        assert_eq!(mul_div_ceil(8, 1, 2).unwrap(), 4);
        assert_eq!(div_q64_ceil(ONE_Q64, ONE_Q64).unwrap(), ONE_Q64);
    }

    #[test]
    fn mul_div_wide_path_agrees_with_the_narrow_one() {
        // a*b overflows u128, forcing the U256 branch.
        let a = u128::MAX / 3;
        let (b, d) = (5u128, 7u128);
        assert!(a.checked_mul(b).is_none());
        assert_eq!(mul_div(a, b, d).unwrap(), U256::mul(a, b).div_u128(d).unwrap());
    }

    #[test]
    fn shr_spans_the_word_boundary() {
        let w = U256 { hi: 1, lo: 0 };
        assert_eq!(w.shr(0), w);
        assert_eq!(w.shr(1).lo, 1u128 << 127);
        assert_eq!(w.shr(128).lo, 1);
        assert_eq!(w.shr(129).lo, 0);
        assert_eq!(w.shr(256), U256::ZERO);
    }
}
