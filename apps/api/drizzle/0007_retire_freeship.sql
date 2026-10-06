-- Standard delivery is free on every order (2026-10-06), so the sample FREESHIP coupon gives nothing.
UPDATE "coupons" SET "active" = false WHERE "code" = 'FREESHIP';
