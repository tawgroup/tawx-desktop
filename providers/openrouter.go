package providers

import (
	"context"
	"strings"
)

const openRouterPrefix = "openrouter/"

// OpenRouter adapts gateway selector names to OpenRouter's model IDs.
type OpenRouter struct{ upstream *OpenAI }

func NewOpenRouter(apiKey, baseURL string) *OpenRouter {
	if baseURL == "" {
		baseURL = "https://openrouter.ai/api"
	}
	return &OpenRouter{upstream: NewOpenAI(apiKey, baseURL)}
}

func (o *OpenRouter) ChatCompletion(ctx context.Context, req *ChatCompletionRequest) (*ChatCompletionResponse, error) {
	copy := *req
	copy.Model = strings.TrimPrefix(req.Model, openRouterPrefix)
	return o.upstream.ChatCompletion(ctx, &copy)
}

func (o *OpenRouter) ChatCompletionStream(ctx context.Context, req *ChatCompletionRequest) (<-chan StreamEvent, error) {
	copy := *req
	copy.Model = strings.TrimPrefix(req.Model, openRouterPrefix)
	copy.StreamOptions = &StreamOptions{IncludeUsage: true}
	return o.upstream.ChatCompletionStream(ctx, &copy)
}

func (o *OpenRouter) ListModels(ctx context.Context) ([]Model, error) {
	models, err := o.upstream.ListModels(ctx)
	if err != nil {
		return nil, err
	}
	for i := range models {
		models[i].ID = openRouterPrefix + models[i].ID
	}
	return models, nil
}
