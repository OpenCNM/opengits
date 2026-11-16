package credits

// LedgerEntry represents a single unified credit history item (grant, market, import consumption, shelf fee, or signup gift).
type LedgerEntry struct {
	ID           string  `json:"id"`
	Amount       int     `json:"amount"`
	Source       string  `json:"source"`
	RepositoryID *string `json:"repositoryId"`
	Detail       *string `json:"detail"`
	At           string  `json:"at"`
	RepoLabel    *string `json:"repoLabel,omitempty"`
}

// PaginationInfo describes pagination details for the credit ledger.
type PaginationInfo struct {
	Total      int `json:"total"`
	Page       int `json:"page"`
	PageSize   int `json:"pageSize"`
	TotalPages int `json:"totalPages"`
}

// CreditsLedgerInput is the input for querying a user's credit ledger.
type CreditsLedgerInput struct {
	UserID   string `json:"userId"`
	Page     int    `json:"page"`
	PageSize int    `json:"pageSize"`
}

// CreditsLedgerResult is the response payload for credit ledger query.
type CreditsLedgerResult struct {
	Entries    []LedgerEntry  `json:"entries"`
	Pagination PaginationInfo `json:"pagination"`
	Balance    int            `json:"balance"`
	SavedRepos int            `json:"savedRepos"`
}

// ShelfFeeChargeInput is the input for charging a shelf fee and bookmarking a tutorial.
type ShelfFeeChargeInput struct {
	UserID       string `json:"userId"`
	RepositoryID string `json:"repositoryId"`
	Fee          int    `json:"fee"`
	AutoFollow   bool   `json:"autoFollow"`
}

// ShelfFeeChargeResult is the result of charging a shelf fee.
type ShelfFeeChargeResult struct {
	OK           bool    `json:"ok"`
	Code         *string `json:"code,omitempty"`
	Fee          int     `json:"fee"`
	Balance      int     `json:"balance"`
	SignupGift   int     `json:"signupGift"`
	AlreadySaved bool    `json:"alreadySaved"`
}

// ImportRewardGrantInput is the input for granting an import reward.
type ImportRewardGrantInput struct {
	RepositoryID string `json:"repositoryId"`
	UserID       string `json:"userId"`
	Amount       int    `json:"amount"`
	Owner        string `json:"owner"`
	Repo         string `json:"repo"`
}

// ImportRewardGrantResult is the result of granting an import reward.
type ImportRewardGrantResult struct {
	Granted         bool   `json:"granted"`
	Amount          int    `json:"amount"`
	ImmediateAmount int    `json:"immediateAmount,omitempty"`
	PendingAmount   int    `json:"pendingAmount,omitempty"`
	VestingDays     int    `json:"vestingDays,omitempty"`
	Reason          string `json:"reason,omitempty"`
}

// VestingUnlockResult is the result of unlocking due pending credit grants.
type VestingUnlockResult struct {
	OK            bool `json:"ok"`
	UnlockedCount int  `json:"unlockedCount"`
	TotalCredits  int  `json:"totalCredits"`
}

