package credits

type LedgerEntry struct {
	ID           string  `json:"id"`
	Amount       int     `json:"amount"`
	Source       string  `json:"source"`
	RepositoryID *string `json:"repositoryId"`
	Detail       *string `json:"detail"`
	At           string  `json:"at"`
	RepoLabel    *string `json:"repoLabel,omitempty"`
}

type PaginationInfo struct {
	Total      int `json:"total"`
	Page       int `json:"page"`
	PageSize   int `json:"pageSize"`
	TotalPages int `json:"totalPages"`
}

type CreditsLedgerInput struct {
	UserID   string `json:"userId"`
	Page     int    `json:"page"`
	PageSize int    `json:"pageSize"`
}

type CreditsLedgerResult struct {
	Entries    []LedgerEntry  `json:"entries"`
	Pagination PaginationInfo `json:"pagination"`
	Balance    int            `json:"balance"`
	SavedRepos int            `json:"savedRepos"`
}

type ShelfFeeChargeInput struct {
	UserID       string `json:"userId"`
	RepositoryID string `json:"repositoryId"`
	Fee          int    `json:"fee"`
	AutoFollow   bool   `json:"autoFollow"`
}

type ShelfFeeChargeResult struct {
	OK           bool    `json:"ok"`
	Code         *string `json:"code,omitempty"`
	Fee          int     `json:"fee"`
	Balance      int     `json:"balance"`
	SignupGift   int     `json:"signupGift"`
	AlreadySaved bool    `json:"alreadySaved"`
}

type ImportRewardGrantInput struct {
	RepositoryID string `json:"repositoryId"`
	UserID       string `json:"userId"`
	Amount       int    `json:"amount"`
	Owner        string `json:"owner"`
	Repo         string `json:"repo"`
}

type ImportRewardGrantResult struct {
	Granted         bool   `json:"granted"`
	Amount          int    `json:"amount"`
	ImmediateAmount int    `json:"immediateAmount,omitempty"`
	PendingAmount   int    `json:"pendingAmount,omitempty"`
	VestingDays     int    `json:"vestingDays,omitempty"`
	Reason          string `json:"reason,omitempty"`
}

type VestingUnlockResult struct {
	OK            bool `json:"ok"`
	UnlockedCount int  `json:"unlockedCount"`
	TotalCredits  int  `json:"totalCredits"`
}
