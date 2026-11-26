package authtoken

const InsecureDefaultToken = "dev-internal-token-change-me"

func IsProductionEnv(appEnv string) bool {
	return appEnv == "production"
}

// Reject the compose default secret in production to match Node internal-auth 403 fail-closed policy.
func RefuseInsecureDefault(internalToken, appEnv string) bool {
	return IsProductionEnv(appEnv) && internalToken == InsecureDefaultToken
}
