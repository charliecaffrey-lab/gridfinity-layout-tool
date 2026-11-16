/**
 * True in the static self-hosted build, which has no backend. Controls that
 * only reach the public site's cloud (sharing, sign-in, phone scan) or that
 * promote it (tips, feedback, learn links) are left out there.
 */
export const IS_SELF_HOSTED = (import.meta.env.VITE_SELF_HOSTED as string | undefined) === '1';
