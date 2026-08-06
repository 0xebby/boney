import type {NextConfig} from "next";

const nextConfig: NextConfig = {
  // The default bottom-left dev indicator overlaps the sidebar footer, covering the wallet
  // button. Moved rather than disabled, so compile and runtime errors are still surfaced.
  devIndicators: {
    position: "bottom-right",
  },
};

export default nextConfig;
