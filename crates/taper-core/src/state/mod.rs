pub mod bin_array;
pub mod config;
pub mod pool;
pub mod position;

pub use bin_array::*;
pub use config::*;
pub use pool::*;
pub use position::*;

#[cfg(test)]
mod layout_tests {
    use super::*;
    use crate::constants::{MAX_BINS_PER_EXTEND, POSITION_BIN_DATA_SIZE};

    /// Account sizes are ABI. Clients read these structs by byte offset, so a
    /// field added anywhere but the reserved tail silently reinterprets every
    /// field after it. Grow into `_reserved`, never past it.
    #[test]
    fn account_sizes_are_frozen() {
        assert_eq!(Config::LEN, 168, "Config");
        assert_eq!(Pool::LEN, 432, "Pool");
        assert_eq!(BinArray::LEN, 6792, "BinArray");
        // The *minimum*: a position with only its inline bins. Growth is
        // appended past this, so every offset below it stays where it is.
        assert_eq!(Position::LEN, 4616, "Position");
        assert_eq!(Position::len_for(70), 4616, "Position, inline only");
        assert_eq!(Position::len_for(1), 4616, "a narrow band still allocates the block");
        assert_eq!(Position::len_for(71), 4616 + 64, "one appended record");
        assert_eq!(Position::len_for(1_400), 4616 + 1_330 * 64, "a full-width band");
        assert_eq!(core::mem::size_of::<Bin>(), 96, "Bin");
        assert_eq!(core::mem::size_of::<PositionBinFee>(), 48, "PositionBinFee");
        // An appended record is a share followed by the same fee struct, so
        // the two halves of a slot are addressed by one stride.
        assert_eq!(core::mem::size_of::<PositionBinData>(), 64, "PositionBinData");
        assert_eq!(
            core::mem::size_of::<PositionBinData>(),
            POSITION_BIN_DATA_SIZE,
            "the constant and the struct must agree"
        );
    }

    /// Packed layout means no padding anywhere, which is what makes the
    /// byte-offset readers on the client side valid — and what makes the
    /// `bytemuck::Pod` derive accept these structs at all.
    #[test]
    fn state_structs_have_no_padding() {
        assert_eq!(core::mem::align_of::<Config>(), 1);
        assert_eq!(core::mem::align_of::<Pool>(), 1);
        assert_eq!(core::mem::align_of::<BinArray>(), 1);
        assert_eq!(core::mem::align_of::<Position>(), 1);

        // Field sizes sum exactly to the whole, i.e. nothing is padding.
        assert_eq!(
            32 + 16 + 16 + 4 + 4 + 2 + 2 + 1 + 2 + 1 + 2 + 2 + 2 + 4 + 4 + 1 + 65,
            core::mem::size_of::<Config>()
        );
        assert_eq!(
            32 * 6 + 128 + 8 + 8 + 8 + 4 + 4 + 4 + 4 + 1 + 1 + 1 + 1 + 1 + 1 + 58,
            core::mem::size_of::<Pool>()
        );
        assert_eq!(
            32 + 8 + 24 + 70 * 96,
            core::mem::size_of::<BinArray>()
        );
        assert_eq!(
            32 + 32 + 70 * 16 + 70 * 48 + 8 + 8 + 8 + 4 + 4 + 1 + 31,
            core::mem::size_of::<Position>()
        );
        assert_eq!(core::mem::align_of::<PositionBinData>(), 1);
        assert_eq!(16 + 48, core::mem::size_of::<PositionBinData>());
    }

    /// All four are well under the 10,240-byte ceiling on a `system_program`
    /// create-account CPI, so `init` works without a separate realloc path.
    ///
    /// A position wider than the inline block reaches its size by growing
    /// afterwards, which is a different limit — the runtime caps growth at
    /// 10,240 bytes per transaction, which is what `MAX_BINS_PER_EXTEND`
    /// encodes.
    #[test]
    fn accounts_fit_a_single_create_account_cpi() {
        for len in [Config::LEN, Pool::LEN, BinArray::LEN, Position::LEN] {
            assert!(len <= 10_240, "{len} exceeds the CPI create limit");
        }
        assert!(
            MAX_BINS_PER_EXTEND * POSITION_BIN_DATA_SIZE <= 10_240,
            "one extend must fit the per-transaction realloc ceiling"
        );
    }
}
