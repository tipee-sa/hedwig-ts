/**
 * Represents a Hedwig JWT, which is used to authenticate and join channels.
 *
 * A token is usually obtained from the server after some authorization process
 * and encapsulates all the necessary information to join a specific channel. It
 * will be forwarded to the Hedwig Hub to subscribe to the channel it describes.
 */
export class HedwigToken {
  readonly raw: string
  readonly channel: string
  readonly tokenLifetime: number
  readonly tokenExpiration: number
  readonly subscriptionLifetime: number
  readonly subscriptionExpiration: number
  readonly features: Features

  constructor(token: string) {
    this.raw = token

    const [/* app */, payloadBase64, /* signature */] = token.split('.')
    // We ignore the signature part as it is not needed for the client-side
    // logic. It is assumed to be correct and will be forwarded as-is.

    let payloadJson: string
    try {
      payloadJson = window.atob(payloadBase64)
    } catch (error: any) {
      // DOMException is thrown for invalid characters
      throw new Error(`Failed to decode token payload Base64: ${error.message}`)
    }

    let payload: unknown
    try {
      payload = JSON.parse(payloadJson)
    } catch (error: any) {
      throw new Error(`Failed to parse token payload JSON: ${error.message}`)
    }

    // Validate the structure and types of the payload
    if (
      payload &&
      typeof payload === 'object' &&
      'c' in payload &&
      typeof payload.c === 'string' && // Channel
      'e' in payload &&
      typeof payload.e === 'number' && // Expiration (seconds)
      'l' in payload &&
      typeof payload.l === 'number' // Lifetime (seconds)
    ) {
      this.channel = payload.c

      // To avoid clock skew, use the local time to compute expiration instants
      const now = Date.now()

      this.tokenLifetime = payload.e * 1000
      this.tokenExpiration = now + this.tokenLifetime

      this.subscriptionLifetime = payload.l * 1000
      this.subscriptionExpiration = now + this.subscriptionLifetime

      this.features = 'f' in payload ? parseFeatures(payload.f) : {};
    } else {
      throw new Error('Invalid token payload structure: missing or incorrect types for required fields (c, e, l).')
    }
  }

  get isValid(): boolean {
    return Date.now() < this.tokenExpiration
  }
}

function parseFeatures(f: unknown): Features {
  const features: Features = {};
  if (!Array.isArray(f)) {
    return features;
  }

  for (const feature of f) {
    if (typeof feature === 'string' && feature === 'events') {
      features[feature] = {};
    } else if (typeof feature === 'object') {
      if ('claims' in feature) {
        features['claims'] = feature.claims;
      } else if ('presence' in feature) {
        features['presence'] = feature.presence;
      }
    }
  }

  return features;
}

export type Feature =
  | 'events'
  | { 'claims': { user: string } }
  | { 'presence': { user: string } }
  ;

export type Features = {
  'events'?: {},
  'claims'?: { user: string },
  'presence'?: { user: string },
}
