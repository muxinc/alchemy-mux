import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Provider from "alchemy/Provider";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { MuxLive } from "./Api.ts";
import { Annotation, AnnotationProvider } from "./Annotation.ts";
import { Asset, AssetProvider } from "./Asset.ts";
import { MuxAuth } from "./AuthProvider.ts";
import { Directive, DirectiveProvider } from "./Directive.ts";
import * as Credentials from "./Credentials.ts";
import { LiveStream, LiveStreamProvider } from "./LiveStream.ts";
import { PlaybackRestriction, PlaybackRestrictionProvider } from "./PlaybackRestriction.ts";
import { SigningKey, SigningKeyProvider } from "./SigningKey.ts";
import { SimulcastTarget, SimulcastTargetProvider } from "./SimulcastTarget.ts";
import {
  TranscriptionVocabulary,
  TranscriptionVocabularyProvider,
} from "./TranscriptionVocabulary.ts";
import { Webhook, WebhookProvider } from "./Webhook.ts";

export class Providers extends Provider.ProviderCollection<Providers>()("Mux") {}

/** Mux providers, credentials, and the `alchemy profile` auth entry. */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      Annotation,
      Asset,
      Directive,
      LiveStream,
      PlaybackRestriction,
      SigningKey,
      SimulcastTarget,
      TranscriptionVocabulary,
      Webhook,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        AnnotationProvider(),
        AssetProvider(),
        DirectiveProvider(),
        LiveStreamProvider(),
        PlaybackRestrictionProvider(),
        SigningKeyProvider(),
        SimulcastTargetProvider(),
        TranscriptionVocabularyProvider(),
        WebhookProvider(),
      ),
    ),
    Layer.provideMerge(MuxLive),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(MuxAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
