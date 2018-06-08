module.exports = {
  framework: 'qunit',
  test_page: 'tests/index.html?hidepassed',
  disable_watching: true,
  reporter: 'dot',
  launch_in_ci: ['Chrome'],
  launch_in_dev: ['Chrome'],
  browser_args: {
    Chrome: {
      mode: 'ci',
      args: [
      ],
    },
  },
};
