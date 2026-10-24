import glm from "./glm.js";
import { GLM_START_OAUTH_CONFIG } from "../constants/oauth.js";

// Z.ai Start Plan — same ZCode CLI polling OAuth as glm (requestDeviceCode /
// pollToken are flow-identical), configured with mintPlanApiKey: false so the
// connection keeps the raw Z.AI OAuth access token as accessToken instead of a
// minted coding-plan API key. mapTokens is shared: access_token (the OAuth
// token) lands in accessToken and the zcode JWT rides providerSpecificData for
// the executor's X-Zcode-Authorization header.
const glmStart = {
  ...glm,
  config: GLM_START_OAUTH_CONFIG,
};

export default glmStart;
