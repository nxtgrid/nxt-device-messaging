/**
 * @fileoverview OpenAPI document + Swagger UI (ADR-001 §3 / ADR-003 §7).
 *
 * Paths mirror `nxt-sts`: machine JSON at `/v3/api-docs`, UI at `/swagger`.
 * Docs endpoints stay unauthenticated; command routes keep Bearer separately.
 * Outbound delivery events are documented under OpenAPI `webhooks` (not `paths`).
 */

import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  jsonSchemaTransform,
} from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { webhookEventSchema } from '../engine/webhook/event-schema.js';
import {
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
} from '../engine/webhook/sign.js';
import packageJson from '../../package.json' with { type: 'json' };

/** JSON Schema for components — strip Zod draft metadata Fastify/Swagger ignore. */
function webhookEventComponentSchema(): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(webhookEventSchema, {
    target: 'draft-2020-12',
  }) as Record<string, unknown>;
  const { $schema: _schema, id: _id, ...rest } = jsonSchema;
  return rest;
}

/**
 * Registers `@fastify/swagger`, Swagger UI, and the STS-mirrored JSON route.
 * Call before application routes so transforms apply; the document is built
 * dynamically when `/v3/api-docs` is requested.
 */
export async function registerOpenApi(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'NXT Device Messaging',
        description: [
          'Reliable, prioritized, retrying command delivery to addressable field devices.',
          '',
          '**Outbound event webhook:** when `eventWebhook.url` is configured, this service',
          'POSTs delivery events to the adopter (see OpenAPI `webhooks`). That is not an',
          'inbound route on this server. Optional HMAC via `DEVICE_MESSAGING_WEBHOOK_SECRET`.',
        ].join('\n'),
        version: packageJson.version,
      },
      components: {
        schemas: {
          WebhookEvent: webhookEventComponentSchema(),
        },
      },
      webhooks: {
        deliveryEvent: {
          post: {
            operationId: 'deliveryEventWebhook',
            summary: 'Outbound delivery event (service → adopter)',
            description: [
              'This service POSTs to the adopter URL configured as `eventWebhook.url`.',
              'Expect **2xx** to acknowledge. Retries reuse the same `eventId`.',
              `Always includes \`${ WEBHOOK_EVENT_ID_HEADER }\`.`,
              `When the signing secret is set, also \`${ WEBHOOK_SIGNATURE_HEADER }: sha256=<hex>\``,
              'over the exact raw JSON body.',
            ].join(' '),
            parameters: [
              {
                name: WEBHOOK_EVENT_ID_HEADER,
                in: 'header',
                required: true,
                schema: { type: 'string' },
                description: 'Same value as `body.eventId` (idempotent retries).',
              },
              {
                name: WEBHOOK_SIGNATURE_HEADER,
                in: 'header',
                required: false,
                schema: { type: 'string' },
                description:
                  'Opt-in HMAC-SHA256 of the raw body (`sha256=<hex>`). Absent when unsigned.',
              },
            ],
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/WebhookEvent' },
                },
              },
            },
            responses: {
              '2XX': {
                description: 'Adopter accepted the notification',
              },
            },
          },
        },
      },
    },
    transform: jsonSchemaTransform,
  });

  await app.register(swaggerUi, {
    routePrefix: '/swagger',
  });

  app.get('/v3/api-docs', {
    schema: { hide: true },
  }, async () => app.swagger());
}
