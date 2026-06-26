export type VolcengineIpModelOption = {
  id: string;
  label: string;
  detail: string;
};

export const VOLCENGINE_IP_SEEDANCE_2_0_MODEL_ID = 'doubao-seedance-2-0-260128';
export const VOLCENGINE_IP_SEEDANCE_2_0_FAST_MODEL_ID = 'doubao-seedance-2-0-fast-260128';
export const VOLCENGINE_IP_SEEDANCE_2_0_MINI_MODEL_ID = 'doubao-seedance-2-0-mini-260615';

export const VOLCENGINE_IP_MODEL_OPTIONS: VolcengineIpModelOption[] = [
  {
    id: VOLCENGINE_IP_SEEDANCE_2_0_MODEL_ID,
    label: 'Seedance 2.0',
    detail: '480p / 720p / 1080p / 4k',
  },
  {
    id: VOLCENGINE_IP_SEEDANCE_2_0_FAST_MODEL_ID,
    label: 'Seedance 2.0 Fast',
    detail: '480p / 720p',
  },
  {
    id: VOLCENGINE_IP_SEEDANCE_2_0_MINI_MODEL_ID,
    label: 'Seedance 2.0 Mini',
    detail: '480p / 720p',
  },
];
