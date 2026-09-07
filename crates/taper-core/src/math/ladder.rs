//! The tapered price ladder.
//!
//! Meteora's DLMM spaces bins at a constant ratio: `P(i) = (1 + s)^i`. Every
//! bin is the same percentage wide, forever.
//!
//! Taper lets that percentage itself decay with the bin index. Writing bin
//! widths in log2 price units:
//!
//! ```text
//!   w(i) = w0 * tau^i                     width of bin i, in log2 price
//!   v(i) = w0 * (1 - tau^i) / (1 - tau)   log2 price at bin i
//!   P(i) = 2^v(i)                         price at bin i, Q64.64
//! ```
//!
//! With `tau < 1` the ladder **widens downward and tightens upward**: a token
//! that launches cheap gets coarse bins (few of them cover a big range), and
//! as it appreciates the bins refine on their own.
//!
//! Three properties worth stating explicitly:
//!
//! * **`tau = 1` degenerates to `v(i) = w0 * i`** — exactly DLMM's uniform
//!   ladder. Taper is a strict superset, so the same program runs classic
//!   pools.
//! * **The ladder is anchored at bin 0 = price 1.0** (per lamport, as in
//!   DLMM), so `w0` is the width *at price 1.0*, not at the pool's current
//!   price. Pick `w0` and `tau` for the width you want where you actually
//!   trade; [`Ladder::step_bp_x100`] reports it for any bin.
//! * **Prices have a ceiling** at `2^(w0 / (1 - tau))`, since the widths form
//!   a convergent geometric series. Downward there is no such limit. Configs
//!   pin the usable band in `min_bin_id..=max_bin_id`, and
//!   [`Ladder::validate_range`] is what proves that band is sound.

use crate::constants::{
    MAX_BIN_PER_ARRAY, MAX_STEP_BP_X100, MIN_STEP_BP_X100, ONE_Q64, STEP_UNITS_PER_ONE,
};
use crate::errors::{CoreError, Result};
use crate::require;
use crate::math::fixed::{exp2, exp2_minus_one_small, pow_q64};
use crate::math::u256::{div_q64, mul_div, mul_div_round, mul_q64};

/// Sanity floor for the taper factor. The real constraint is that
/// [`Ladder::validate_range`] must pass over the config's bin range, which
/// forces `tau` far closer to 1 than this for any useful range.
pub const MIN_TAPER_Q64: u128 = 17_524_406_870_024_074_035; // 0.95 in Q64.64
/// `tau = 1.0` — a uniform, DLMM-equivalent ladder.
pub const MAX_TAPER_Q64: u128 = ONE_Q64;

/// The two numbers that define a pool's price ladder.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ladder {
    /// `w0`: width of bin 0 in log2 price units, Q64.64.
    pub base_width_q64: u128,
    /// `tau`: per-bin decay of the width, Q64.64, in `(MIN_TAPER, 1.0]`.
    pub taper_q64: u128,
}

impl Ladder {
    pub fn new(base_width_q64: u128, taper_q64: u128) -> Result<Self> {
        require!(base_width_q64 > 0, CoreError::InvalidBaseWidth);
        require!(
            (MIN_TAPER_Q64..=MAX_TAPER_Q64).contains(&taper_q64),
            CoreError::InvalidTaper
        );
        Ok(Ladder {
            base_width_q64,
            taper_q64,
        })
    }

    /// True when the ladder is uniform, i.e. plain DLMM spacing.
    pub fn is_uniform(&self) -> bool {
        self.taper_q64 == MAX_TAPER_Q64
    }

    /// `tau^|id|`, which is always in `(0, 1]` and so never overflows.
    ///
    /// Working with the absolute exponent is what keeps the ladder cheap.
    /// The obvious `tau^id` needs a reciprocal for the (very common) negative
    /// ids, and a 256-bit reciprocal costs a full long division — the single
    /// most expensive operation in the program. Every formula below instead
    /// folds the sign in algebraically, so `pow` is the only work done.
    fn taper_pow_abs(&self, id: i32) -> Result<u128> {
        pow_q64(self.taper_q64, id.unsigned_abs())
    }

    /// `w(i) = w0 * tau^i` — the width of bin `i` in log2 price units.
    pub fn width(&self, id: i32) -> Result<u128> {
        if self.is_uniform() {
            return Ok(self.base_width_q64);
        }
        self.width_from_q(id, self.taper_pow_abs(id)?)
    }

    fn width_from_q(&self, id: i32, q: u128) -> Result<u128> {
        let w = if id >= 0 {
            mul_q64(self.base_width_q64, q)?
        } else {
            // `tau^|id|` underflowing to zero means this bin sits further
            // below the anchor than the ladder can express at all.
            require!(q > 0, CoreError::BinIdOutOfRange);
            // w0 / tau^|id|. `w0 << 64` stays inside u128 for any sane width,
            // so this takes the narrow division path.
            div_q64(self.base_width_q64, q)?
        };
        require!(w > 0, CoreError::BinIdOutOfRange);
        Ok(w)
    }

    /// `v(i) = w0 * (1 - tau^i) / (1 - tau)` — signed log2 price of bin `i`.
    pub fn log2_price(&self, id: i32) -> Result<i128> {
        if self.is_uniform() {
            return (self.base_width_q64 as i128)
                .checked_mul(id as i128)
                .ok_or_else(|| CoreError::MathOverflow);
        }
        self.log2_price_from_q(id, self.taper_pow_abs(id)?)
    }

    fn log2_price_from_q(&self, id: i32, q: u128) -> Result<i128> {
        let one_minus_tau = ONE_Q64 - self.taper_q64; // positive: tau < 1 here
        let one_minus_q = ONE_Q64 - q; // positive: q <= 1

        if id >= 0 {
            //        w0 (1 - tau^i)
            //  v  =  --------------
            //           1 - tau
            to_i128(mul_div(self.base_width_q64, one_minus_q, one_minus_tau)?)
        } else {
            // With q = tau^|i|, the identity tau^i = 1/q turns
            //   w0 (1 - 1/q) / (1 - tau)   into   -w0 (1 - q) / (q (1 - tau)),
            // which needs no reciprocal and subtracts two numbers that are not
            // nearly equal, so it is better conditioned as well as cheaper.
            require!(q > 0, CoreError::BinIdOutOfRange);
            let den = mul_q64(q, one_minus_tau)?;
            require!(den > 0, CoreError::BinIdOutOfRange);
            Ok(-to_i128(mul_div(
                self.base_width_q64,
                one_minus_q,
                den,
            )?)?)
        }
    }

    /// `P(i) = 2^v(i)` in Q64.64. Errors outside the representable band.
    pub fn price(&self, id: i32) -> Result<u128> {
        exp2(self.log2_price(id)?)
    }

    /// Bin `i`'s width as a price ratio, in hundredths of a basis point
    /// (1 unit = 1e-6). This is the per-bin analogue of DLMM's `bin_step`,
    /// and it is what the fee schedule keys off.
    ///
    /// Derived from `w(i)` rather than from `P(i+1)/P(i)` so it does not
    /// depend on the price magnitude; the two agree to well below one unit.
    pub fn step_bp_x100(&self, id: i32) -> Result<u32> {
        step_units(self.width(id)?)
    }

    /// Price and width together, sharing the single `tau^|id|` computation.
    ///
    /// This is what bin initialisation calls: deriving the two separately
    /// would run the binary exponentiation twice for the same bin.
    pub fn derive(&self, id: i32) -> Result<(u128, u32)> {
        if self.is_uniform() {
            return Ok((self.price(id)?, step_units(self.base_width_q64)?));
        }
        let q = self.taper_pow_abs(id)?;
        let price = exp2(self.log2_price_from_q(id, q)?)?;
        let step = step_units(self.width_from_q(id, q)?)?;
        Ok((price, step))
    }

    /// Prove that `min_bin_id..=max_bin_id` is a sound band for this ladder.
    ///
    /// Checking only the two endpoints is sufficient, not merely convenient:
    ///
    /// * Price rises monotonically in `i` and width falls monotonically in
    ///   `i`, so bounding both ends bounds every bin between them.
    /// * The one property that is *not* monotonic is whether two adjacent
    ///   bins are still distinguishable in Q64.64. That needs
    ///   `P(i) * w(i)` to stay above one ulp, and
    ///   `d/di [ log2 P(i) + log2 w(i) ] = w(i) + log2(tau)` starts positive
    ///   and turns negative exactly once — so the quantity is unimodal and
    ///   its minimum over the band is at one of the endpoints. Testing both
    ///   ends is therefore a proof for the whole band, not a spot check.
    pub fn validate_range(&self, min_bin_id: i32, max_bin_id: i32) -> Result<()> {
        require!(min_bin_id < max_bin_id, CoreError::InvalidBinRange);

        // Anything that fails while probing the endpoints — an overflow, a
        // width that underflows, a price off the end of Q64.64 — means the
        // band itself is unusable. Callers asked one question, so they get one
        // answer rather than whichever internal limit happened to trip first.
        let bad = || CoreError::InvalidBinRange;

        // Both endpoint prices must exist in Q64.64...
        let low = self.price(min_bin_id).map_err(|_| bad())?;
        let high = self.price(max_bin_id).map_err(|_| bad())?;
        require!(low < high, CoreError::InvalidBinRange);

        // ...and adjacent bins must not collide onto the same Q64.64 price.
        require!(
            self.price(min_bin_id + 1).map_err(|_| bad())? > low,
            CoreError::InvalidBinRange
        );
        require!(
            high > self.price(max_bin_id - 1).map_err(|_| bad())?,
            CoreError::InvalidBinRange
        );

        // Widest bin sits at the bottom, narrowest at the top.
        let widest = self.step_bp_x100(min_bin_id).map_err(|_| bad())?;
        let narrowest = self.step_bp_x100(max_bin_id).map_err(|_| bad())?;
        require!(widest <= MAX_STEP_BP_X100, CoreError::InvalidBinRange);
        require!(narrowest >= MIN_STEP_BP_X100, CoreError::InvalidBinRange);

        Ok(())
    }
}

fn to_i128(v: u128) -> Result<i128> {
    i128::try_from(v).map_err(|_| CoreError::MathOverflow)
}

/// A log2 width as a price ratio, in hundredths of a basis point.
fn step_units(width_q64: u128) -> Result<u32> {
    let step = exp2_minus_one_small(width_q64)?;
    let units = mul_div_round(step, STEP_UNITS_PER_ONE, ONE_Q64)?;
    u32::try_from(units).map_err(|_| CoreError::InvalidBinRange)
}

/// Index of the `BinArray` holding `bin_id`. Floors towards negative
/// infinity, so array `-1` covers bins `-70..=-1`.
pub fn bin_array_index(bin_id: i32) -> i32 {
    bin_id.div_euclid(MAX_BIN_PER_ARRAY as i32)
}

/// Lowest bin id stored in a given bin array.
pub fn bin_array_lower_bin_id(index: i32) -> i32 {
    index * MAX_BIN_PER_ARRAY as i32
}

/// Highest bin id stored in a given bin array.
pub fn bin_array_upper_bin_id(index: i32) -> i32 {
    bin_array_lower_bin_id(index) + MAX_BIN_PER_ARRAY as i32 - 1
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::fixed::tests::assert_rel;
    use crate::math::fixed::{f64_to_q64, q64_to_f64};

    /// `w0` for a bin step of `bps` basis points at the anchor.
    fn width_for_bps(bps: f64) -> u128 {
        f64_to_q64((1.0 + bps / 10_000.0).log2())
    }

    /// `tau` that halves the bin width every `bins` bins going up.
    fn taper_for_half_life(bins: f64) -> u128 {
        f64_to_q64(2f64.powf(-1.0 / bins))
    }

    fn uniform(bps: f64) -> Ladder {
        Ladder::new(width_for_bps(bps), MAX_TAPER_Q64).unwrap()
    }

    #[test]
    fn uniform_ladder_reproduces_dlmm() {
        // P(i) must equal (1 + bin_step/10_000)^i. `span` is the widest bin
        // id that keeps the price inside the Q64.64 band for that bin step.
        let cases: [(f64, i32); 5] = [
            (1.0, 20_000),
            (10.0, 20_000),
            (25.0, 10_000),
            (100.0, 2_000),
            (400.0, 500),
        ];
        for (bps, span) in cases {
            let l = uniform(bps);
            let ratio = 1.0 + bps / 10_000.0;
            for id in [-span, -span / 2, -1, 0, 1, span / 2, span] {
                let got = q64_to_f64(l.price(id).unwrap());
                let want = ratio.powi(id);
                assert_rel(got, want, 1e-9, &format!("bps={bps} id={id}"));
            }
        }
    }

    #[test]
    fn uniform_ladder_step_matches_its_bin_step() {
        for bps in [1.0, 10.0, 25.0, 100.0, 400.0] {
            let l = uniform(bps);
            let want = (bps * 100.0).round() as u32;
            for id in [-5000i32, 0, 5000] {
                let got = l.step_bp_x100(id).unwrap();
                assert!(
                    got.abs_diff(want) <= 1,
                    "bps={bps} id={id}: got {got}, want {want}"
                );
            }
        }
    }

    #[test]
    fn price_is_one_at_the_anchor() {
        let l = Ladder::new(width_for_bps(10.0), taper_for_half_life(20_000.0)).unwrap();
        assert_eq!(l.price(0).unwrap(), ONE_Q64);
        assert_eq!(l.log2_price(0).unwrap(), 0);
    }

    #[test]
    fn taper_widens_downward_and_tightens_upward() {
        let l = Ladder::new(width_for_bps(10.0), taper_for_half_life(20_000.0)).unwrap();
        let below = l.step_bp_x100(-20_000).unwrap();
        let at = l.step_bp_x100(0).unwrap();
        let above = l.step_bp_x100(20_000).unwrap();

        // One half-life down doubles the width; one up halves it.
        assert!(below > at && at > above, "{below} > {at} > {above}");
        assert!((below as f64 / at as f64 - 2.0).abs() < 0.01);
        assert!((above as f64 / at as f64 - 0.5).abs() < 0.01);
    }

    #[test]
    fn widths_decrease_monotonically_in_bin_id() {
        let l = Ladder::new(width_for_bps(25.0), taper_for_half_life(5_000.0)).unwrap();
        let mut prev = l.width(-5_000).unwrap();
        for id in (-4_999..=5_000).step_by(37) {
            let w = l.width(id).unwrap();
            assert!(w < prev, "width did not decrease at id={id}");
            prev = w;
        }
    }

    #[test]
    fn prices_increase_strictly_bin_by_bin() {
        let l = Ladder::new(width_for_bps(10.0), taper_for_half_life(8_000.0)).unwrap();
        // Walk every single bin across a wide band; no ties allowed anywhere.
        let mut prev = l.price(-6_000).unwrap();
        for id in -5_999..=6_000 {
            let p = l.price(id).unwrap();
            assert!(p > prev, "price not strictly increasing at id={id}");
            prev = p;
        }
    }

    #[test]
    fn consecutive_prices_agree_with_the_reported_step() {
        let l = Ladder::new(width_for_bps(20.0), taper_for_half_life(10_000.0)).unwrap();
        for id in [-9_000i32, -1_000, 0, 1_000, 9_000] {
            let p0 = q64_to_f64(l.price(id).unwrap());
            let p1 = q64_to_f64(l.price(id + 1).unwrap());
            let implied = (p1 / p0 - 1.0) * 1e6;
            let reported = l.step_bp_x100(id).unwrap() as f64;
            assert!(
                (implied - reported).abs() <= 1.0,
                "id={id}: implied {implied}, reported {reported}"
            );
        }
    }

    #[test]
    fn log2_price_matches_the_closed_form() {
        let (w0, hl) = (10.0f64, 12_000.0f64);
        let l = Ladder::new(width_for_bps(w0), taper_for_half_life(hl)).unwrap();
        let w0f = (1.0 + w0 / 10_000.0).log2();
        let tau = 2f64.powf(-1.0 / hl);
        for id in [-30_000i32, -7_000, -1, 1, 7_000, 30_000] {
            let got = l.log2_price(id).unwrap() as f64 / ONE_Q64 as f64;
            let want = w0f * (1.0 - tau.powi(id)) / (1.0 - tau);
            assert!(
                ((got - want) / want).abs() < 1e-9,
                "id={id}: got {got}, want {want}"
            );
        }
    }

    #[test]
    fn taper_covers_far_more_downside_per_bin_than_uniform() {
        // The headline property: going down, tapered bins each span more
        // price, so a fixed bin budget reaches a much lower price.
        let hl = 6_000.0;
        let tapered = Ladder::new(width_for_bps(10.0), taper_for_half_life(hl)).unwrap();
        let flat = uniform(10.0);
        let tapered_low = q64_to_f64(tapered.price(-8_000).unwrap());
        let flat_low = q64_to_f64(flat.price(-8_000).unwrap());
        assert!(
            tapered_low < flat_low / 100.0,
            "tapered {tapered_low} should be far below uniform {flat_low}"
        );
    }

    #[test]
    fn validate_range_accepts_a_sane_band_and_rejects_a_collapsed_one() {
        let l = Ladder::new(width_for_bps(10.0), taper_for_half_life(20_000.0)).unwrap();
        assert!(l.validate_range(-20_000, 20_000).is_ok());
        assert!(l.validate_range(100, 100).is_err(), "empty band");
        assert!(l.validate_range(20_000, -20_000).is_err(), "inverted band");
        // One half-life further down already runs off the bottom of Q64.64.
        assert!(l.validate_range(-40_000, 20_000).is_err(), "band too deep");

        // A hard taper collapses bins to nothing well before 200k bins up.
        let steep = Ladder::new(width_for_bps(10.0), taper_for_half_life(300.0)).unwrap();
        assert!(steep.validate_range(-1_000, 200_000).is_err());
    }

    #[test]
    fn validate_range_rejects_bins_wider_than_the_cap() {
        // Far enough below the anchor, tapered bins exceed 400 bps.
        let l = Ladder::new(width_for_bps(100.0), taper_for_half_life(2_000.0)).unwrap();
        assert!(l.validate_range(-20_000, 0).is_err());
    }

    #[test]
    fn constructor_rejects_a_taper_outside_the_band() {
        assert!(Ladder::new(width_for_bps(10.0), MIN_TAPER_Q64 - 1).is_err());
        assert!(Ladder::new(width_for_bps(10.0), ONE_Q64 + 1).is_err());
        assert!(Ladder::new(0, ONE_Q64).is_err());
    }

    #[test]
    fn bin_array_index_floors_towards_negative_infinity() {
        assert_eq!(bin_array_index(0), 0);
        assert_eq!(bin_array_index(69), 0);
        assert_eq!(bin_array_index(70), 1);
        assert_eq!(bin_array_index(-1), -1);
        assert_eq!(bin_array_index(-70), -1);
        assert_eq!(bin_array_index(-71), -2);

        for id in [-141i32, -70, -1, 0, 69, 70, 1_000] {
            let idx = bin_array_index(id);
            assert!(bin_array_lower_bin_id(idx) <= id && id <= bin_array_upper_bin_id(idx));
        }
    }
}
