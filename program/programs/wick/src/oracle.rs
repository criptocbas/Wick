use anchor_lang::prelude::*;

use crate::errors::WickError;
use crate::state::{MarketConfig, WickFeed, FEED_KIND_PYTH_LAZER, FEED_KIND_WICK};

pub struct PriceData {
    pub price: i64,
    pub expo: i32,
    pub ts_ms: i64,
}

/// Reads a price from the market's pinned feed account.
///
/// kind 0 — MagicBlock real-time pricing oracle accounts. These use the Pyth receiver
/// `PriceUpdateV2` layout: 8 (discriminator) + 32 (write_authority) + 1 (verification_level,
/// always Full) + 32 (feed_id), then price i64 @73, conf u64 @81, exponent i32 @89,
/// publish_time i64 (seconds) @93. The price offset matches MagicBlock's documented
/// client-side fast read; address pinning to `market.feed` is the integrity guard.
///
/// kind 1 — Wick-pushed feeds (our keeper, Flash Trade prices, millisecond timestamps).
pub fn read_price(market: &MarketConfig, feed_ai: &AccountInfo) -> Result<PriceData> {
    require_keys_eq!(feed_ai.key(), market.feed, WickError::FeedMismatch);
    let data = feed_ai.try_borrow_data()?;
    match market.feed_kind {
        FEED_KIND_PYTH_LAZER => {
            require!(data.len() >= 101, WickError::InvalidFeed);
            let price = i64::from_le_bytes(data[73..81].try_into().unwrap());
            let expo = i32::from_le_bytes(data[89..93].try_into().unwrap());
            let ts_s = i64::from_le_bytes(data[93..101].try_into().unwrap());
            require!(price > 0 && ts_s > 0, WickError::InvalidFeed);
            Ok(PriceData { price, expo, ts_ms: ts_s.saturating_mul(1000) })
        }
        FEED_KIND_WICK => {
            let feed = WickFeed::try_deserialize(&mut data.as_ref())?;
            require!(feed.price > 0 && feed.ts_ms > 0, WickError::InvalidFeed);
            Ok(PriceData { price: feed.price, expo: feed.expo, ts_ms: feed.ts_ms })
        }
        _ => err!(WickError::InvalidFeed),
    }
}

/// Compares two prices that may carry different exponents.
pub fn cmp_prices(p1: i64, e1: i32, p2: i64, e2: i32) -> Result<std::cmp::Ordering> {
    if e1 == e2 {
        return Ok((p1 as i128).cmp(&(p2 as i128)));
    }
    let diff = e1.abs_diff(e2);
    require!(diff <= 18, WickError::InvalidFeed);
    let scale = 10i128.pow(diff);
    let (a, b) = if e1 < e2 {
        (p1 as i128, (p2 as i128).checked_mul(scale).ok_or(WickError::MathOverflow)?)
    } else {
        ((p1 as i128).checked_mul(scale).ok_or(WickError::MathOverflow)?, p2 as i128)
    };
    Ok(a.cmp(&b))
}
