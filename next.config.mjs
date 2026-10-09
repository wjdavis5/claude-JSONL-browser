/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['sqlite-vec'],
  images: {
    unoptimized: true,
  },
}

export default nextConfig