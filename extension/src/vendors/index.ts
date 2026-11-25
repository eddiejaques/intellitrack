import type { VendorMatcher } from "../shared/types";
import { ga4 } from "./ga4";
import { googleAds } from "./googleAds";
import { metaPixel } from "./metaPixel";
import { adobeAnalytics } from "./adobeAnalytics";

/** Registered vendors. Adding a vendor = one file in this folder + one line here. */
export const vendors: VendorMatcher[] = [ga4, googleAds, metaPixel, adobeAnalytics];
