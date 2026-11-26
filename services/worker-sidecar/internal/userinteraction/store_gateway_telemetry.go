package userinteraction

import (
	"context"
	"github.com/opengits/worker-sidecar/internal/platform/db"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

func (s *PgxStore) TouchMcpPresence(ctx context.Context, userID, clientName, clientVer, ip string) error {
	if userID == "" || clientName == "" {
		return nil
	}
	return s.queries.TouchMcpPresence(ctx, db.TouchMcpPresenceParams{
		UserId:     userID,
		ClientName: clientName,
		Column3:    clientVer,
		Column4:    ip,
	})
}

func (s *PgxStore) IncrementMcpUsage(ctx context.Context, userID, day string) error {
	if userID == "" || day == "" {
		return nil
	}
	return s.queries.IncrementMcpUsage(ctx, db.IncrementMcpUsageParams{
		UserId: userID,
		Day:    day,
	})
}

func (s *PgxStore) RecordMcpCallLog(ctx context.Context, input McpCallLogInput) error {
	if input.ToolName == "" {
		return nil
	}
	status := "SUCCESS"
	if input.Status != nil && *input.Status != "" {
		status = *input.Status
	}
	dim := "documents"
	if input.Dimension != nil && *input.Dimension != "" {
		dim = *input.Dimension
	}
	isFallback := input.IsFallback != nil && *input.IsFallback
	return s.queries.RecordMcpCallLog(ctx, db.RecordMcpCallLogParams{
		ToolName:       input.ToolName,
		Column2:        input.UserID,
		Column3:        input.ClientName,
		Column4:        input.RepositoryID,
		Column5:        input.BundleID,
		Dimension:      pgtype.Text{String: dim, Valid: true},
		Status:         status,
		ResultCount:    int32(input.ResultCount),
		ResponseTimeMs: int32(input.ResponseTimeMs),
		Column10:       input.RequestedEdition,
		Column11:       input.ResolvedEdition,
		IsFallback:     isFallback,
	})
}

func (s *PgxStore) RecordGithubQuotaSample(ctx context.Context, input GithubQuotaSampleInput) error {
	if input.Fingerprint == "" {
		return nil
	}
	var resetAt pgtype.Timestamp
	if input.ResetAt != nil && *input.ResetAt != "" {
		if t, err := time.Parse(time.RFC3339, *input.ResetAt); err == nil {
			resetAt = pgtype.Timestamp{Time: t, Valid: true}
		}
	}
	endpointClass := input.EndpointClass
	if endpointClass == "" {
		endpointClass = "REST"
	}
	return s.queries.RecordGithubQuotaSample(ctx, db.RecordGithubQuotaSampleParams{
		Fingerprint:   input.Fingerprint,
		Remaining:     int32(input.Remaining),
		ResetAt:       resetAt,
		EndpointClass: endpointClass,
		Status:        int32(input.Status),
	})
}
