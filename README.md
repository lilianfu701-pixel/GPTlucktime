# GPTlucktime

## Birth validation rate limit

Birth-time validation uses a bounded, in-memory fixed-window limiter: 30 requests
per minute per proxy-derived client key, with at most 5,000 tracked keys. It does
not log birth input or client addresses.

The limiter is local to each serverless instance and resets on cold starts. A
production deployment should also configure Vercel Firewall rate limiting for
global, multi-instance enforcement.
