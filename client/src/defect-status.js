import './defect-status.css';

export const DEFECT_STATUSES = ['待处理', '处理中', '待验证', '搁置', '已解决', '已关闭'];

const classes = {
  待处理: 'pending', 处理中: 'progress', 待验证: 'verify',
  搁置: 'onhold', 已解决: 'resolved', 已关闭: 'closed',
};

export function defectStatusClass(status) {
  return classes[status] ? `defect-status defect-status-${classes[status]}` : '';
}
